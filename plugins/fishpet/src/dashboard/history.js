/**
 * 看板专用的纯观测历史。
 *
 * 这里保存“这一轮实际发生了什么”，供逐轮回放和历史曲线读取；它不参与情绪
 * 判断、不改变账本、也不成为判读事务的一部分。观测写失败只让看板降级，绝不
 * 反向影响一次已经成功的情绪提交。
 *
 * 文件有固定上限并按天淘汰，使用原子 JSON 覆盖，避免半文件。看板标签页不会
 * 直接读取本模块，只通过脱敏投影拿到数据。
 *
 * @module dsh-fishpet-emotion/dashboard/history
 */

import { promises as nodeFs } from 'node:fs';
import path from 'node:path';
import {
  readJson,
  writeJsonAtomic,
} from '../store/atomic-json.js';
import { humanizeAssistantVoice } from '../bridge/lib/reduce.js';
import { summarizeObservedUsage } from './usage.js';

export const DASHBOARD_HISTORY_FILE = 'dashboard-history.json';
export const DASHBOARD_HISTORY_SCHEMA = 1;
export const DEFAULT_HISTORY_MAX_RECORDS = 1000;
export const DEFAULT_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function finite(value) {
  return Number.isFinite(Number(value));
}

function safeLimit(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function normalizeReply(value) {
  if (!isObject(value)) return null;
  const spoken = humanizeAssistantVoice(value.text).slice(0, 4000);
  if (!spoken) return null;
  return {
    ...clone(value),
    text: spoken,
  };
}

function normalizeInsight(value, fallbackSource, max) {
  if (value == null) return null;
  const source = isObject(value) ? value : { text: value };
  const spoken = String(source.text == null ? '' : source.text)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  if (!spoken) return null;
  if (/(系统提示|提示词|系统消息|模型输出|模型内部|工具调用|函数调用|内部推理|JSON|schema|reasoning|assistant|prompt|tool\s*call)/i.test(spoken)) {
    return null;
  }
  return {
    text: spoken,
    at: finite(source.at) ? Number(source.at) : null,
    source: String(source.source || fallbackSource).slice(0, 40),
  };
}

function normalizeAvailable(value, reply, read, monologue) {
  return {
    ...(isObject(value) ? clone(value) : {}),
    reply: Boolean(reply?.text),
    read: Boolean(read?.text),
    monologue: Boolean(monologue?.text),
    modelUsage: isObject(value) && value.modelUsage === true,
  };
}

function normalizeRecord(value) {
  if (!isObject(value)) return null;
  const at = Number(value.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  const eventId = String(value.eventId || '').slice(0, 240);
  const reply = normalizeReply(value.reply);
  const read = normalizeInsight(value.read, 'small-model', 80);
  const monologue = normalizeInsight(value.monologue, 'small-model', 220);
  return {
    ...clone(value),
    schemaVersion: DASHBOARD_HISTORY_SCHEMA,
    eventId,
    at,
    reply,
    read,
    monologue,
    available: normalizeAvailable(value.available, reply, read, monologue),
    status: ['ok', 'failed', 'crisis', 'blocked'].includes(value.status)
      ? value.status
      : 'ok',
  };
}

function collectKnown(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const normalized = normalizeRecord(entry);
    if (normalized) out.push(normalized);
  }
  return out;
}

function thin(points, cap) {
  if (points.length <= cap) return points;
  const out = [];
  const step = points.length / cap;
  for (let index = 0; index < cap; index += 1) {
    out.push(points[Math.min(points.length - 1, Math.trunc(index * step))]);
  }
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out[out.length - 1] = last;
  return out;
}

/**
 * @param {object} options
 * @param {string} options.dir 私有数据目录。
 * @param {object} [options.fs] 测试可注入的文件 API。
 * @param {() => number} [options.clock] 毫秒时钟。
 * @param {(line: string) => void} [options.log] 脱敏日志。
 * @param {number} [options.maxRecords] 固定记录上限。
 * @param {number} [options.retentionMs] 固定保留时长。
 * @returns {object}
 */
export function createDashboardHistory({
  dir,
  fs = nodeFs,
  clock = () => Date.now(),
  log = () => {},
  maxRecords = DEFAULT_HISTORY_MAX_RECORDS,
  retentionMs = DEFAULT_HISTORY_RETENTION_MS,
}) {
  const file = path.join(dir, DASHBOARD_HISTORY_FILE);
  const recordLimit = safeLimit(maxRecords, DEFAULT_HISTORY_MAX_RECORDS, 1, 5000);
  const keepMs = safeLimit(retentionMs, DEFAULT_HISTORY_RETENTION_MS, 60_000, 30 * 86400_000);
  let records = [];
  let phase = 'new';
  let lastError = '';
  let initialized = false;
  let closed = false;
  let chain = Promise.resolve();

  function report(line) {
    try {
      log(String(line));
    } catch {
      /* 日志器失败不影响观测 */
    }
  }

  function noteError(operation, code) {
    lastError = String(code || 'io-error');
    report(`emotion-dashboard: ${operation} failed code=${lastError}`);
  }

  function prune(now) {
    const floor = now - keepMs;
    records = records
      .filter((entry) => Number(entry.at) >= floor)
      .slice(-recordLimit);
  }

  function enqueue(task) {
    const pending = chain.then(task, task);
    chain = pending.catch(() => {});
    return pending;
  }

  async function persist() {
    const body = {
      schemaVersion: DASHBOARD_HISTORY_SCHEMA,
      retentionMs: keepMs,
      records,
    };
    const written = await writeJsonAtomic(file, body, { fs });
    if (!written.ok) {
      noteError('write', written.code);
      return written;
    }
    lastError = '';
    return { ok: true };
  }

  async function init() {
    return enqueue(async () => {
      if (initialized) return { ok: phase === 'ready', phase };
      initialized = true;
      const got = await readJson(file, { fs });
      if (got.missing) {
        phase = 'ready';
        return { ok: true, missing: true };
      }
      if (!got.ok) {
        phase = 'unavailable';
        noteError('read', got.code || 'io-error');
        return { ok: false, code: lastError };
      }
      if (
        !isObject(got.value)
        || got.value.schemaVersion !== DASHBOARD_HISTORY_SCHEMA
        || !Array.isArray(got.value.records)
      ) {
        phase = 'unavailable';
        noteError('read', 'bad-history-schema');
        return { ok: false, code: lastError };
      }
      records = collectKnown(got.value.records);
      prune(Number(clock()));
      phase = 'ready';
      return { ok: true, records: records.length };
    });
  }

  async function record(entry) {
    const normalized = normalizeRecord(entry);
    if (!normalized) return { ok: false, code: 'invalid-observation' };
    await init();
    return enqueue(async () => {
      if (closed) return { ok: false, code: 'closed' };
      if (phase !== 'ready') return { ok: false, code: lastError || 'unavailable' };
      const now = Number(clock());
      const duplicate = normalized.eventId
        ? records.findIndex((item) => item.eventId && item.eventId === normalized.eventId)
        : -1;
      if (duplicate >= 0) records[duplicate] = normalized;
      else records.push(normalized);
      records.sort((left, right) => Number(left.at) - Number(right.at));
      prune(now);
      const written = await persist();
      return written.ok
        ? { ok: true, at: normalized.at, recorded: duplicate < 0 }
        : written;
    });
  }

  /**
   * 回复通常比判读晚到。桥接层拿到助手最终文本后可补到同一轮；同一个
   * eventId 幂等更新，不追加第二条。
   */
  async function attachReply(eventId, reply, extra = {}) {
    const id = String(eventId || '');
    if (!id) return { ok: false, code: 'event-id-required' };
    await init();
    return enqueue(async () => {
      if (closed) return { ok: false, code: 'closed' };
      if (phase !== 'ready') return { ok: false, code: lastError || 'unavailable' };
      const found = records.find((item) => item.eventId === id);
      if (!found) return { ok: false, code: 'round-not-found' };
      const text = humanizeAssistantVoice(reply).slice(0, 4000);
      found.reply = text
        ? {
          text,
          at: finite(extra.at) ? Number(extra.at) : Number(clock()),
          source: String(extra.source || 'integration').slice(0, 40),
        }
        : null;
      found.available = normalizeAvailable(
        found.available,
        found.reply,
        found.read,
        found.monologue,
      );
      if (isObject(extra.usage)) found.usage = clone(extra.usage);
      if (isObject(extra.modelCosts)) found.modelCosts = clone(extra.modelCosts);
      const written = await persist();
      return written.ok ? { ok: true, at: found.at } : written;
    });
  }

  async function recent(limit = 40) {
    await init();
    await chain;
    const count = safeLimit(limit, 40, 1, 200);
    return clone(records.slice(-count).reverse());
  }

  async function points(options = {}) {
    await init();
    await chain;
    const now = finite(options.now) ? Number(options.now) : Number(clock());
    const hours = Number.isFinite(Number(options.hours))
      ? Math.max(1, Math.min(168, Number(options.hours)))
      : 168;
    const since = now - hours * 3600_000;
    const cap = safeLimit(options.max, 240, 2, 1000);
    const rows = [];
    for (const entry of records) {
      if (Number(entry.at) < since) continue;
      const axes = isObject(entry.axesAfter) ? entry.axesAfter : null;
      if (!axes) continue;
      rows.push({
        at: Number(entry.at),
        axes: clone(axes),
        eventId: entry.eventId || '',
      });
    }
    return thin(rows, cap);
  }

  /**
   * 全量观测历史的用量汇总。页面只显示最近 60 轮，但“今日/累计用量”不能
   * 因展示截断而漏算。
   *
   * @param {{now?: number}} [options]
   * @returns {Promise<{total: object, today: object}>}
   */
  async function observedUsage(options = {}) {
    await init();
    await chain;
    const now = finite(options.now) ? Number(options.now) : Number(clock());
    return summarizeObservedUsage(records, now);
  }

  function status() {
    return {
      available: phase === 'ready',
      phase,
      records: records.length,
      maxRecords: recordLimit,
      retentionDays: Math.round((keepMs / 86400_000) * 10) / 10,
      earliestAt: records.length ? Number(records[0].at) : 0,
      latestAt: records.length ? Number(records[records.length - 1].at) : 0,
      lastError,
    };
  }

  async function close() {
    closed = true;
    await chain;
  }

  return {
    init,
    record,
    attachReply,
    recent,
    points,
    observedUsage,
    status,
    close,
    get file() {
      return file;
    },
  };
}

