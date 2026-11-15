/**
 * 主动开口状态、定时检查与持久化。
 *
 * 每次 tick 只做本地门控；只有 `materialize()` 成功并真正投递到一个 chat
 * Agent 后，才记一次当日额度。控制器本身不 import 模型或 DSH。
 *
 * @module dsh-fishpet-emotion/life/proactive-runtime
 */

import path from 'node:path';

import {
  PROACTIVE_SCHEMA_VERSION,
  createProactiveState,
  evaluateProactiveGate,
  localDayKey,
  normalizeProactiveSettings,
  normalizeProactiveState,
} from './proactive.js';
import { readJson, writeJsonAtomic } from '../store/atomic-json.js';

export const PROACTIVE_STATE_FILE = 'proactive-state.json';
export const DEFAULT_PROACTIVE_TICK_MS = 60_000;

function safeLog(log, line) {
  try {
    log(String(line || '').slice(0, 240));
  } catch {
    /* 日志失败不影响门控 */
  }
}

/**
 * @param {object} options
 * @param {string} options.dir 状态目录。
 * @param {() => number} [options.clock]
 * @param {number} [options.intervalMs]
 * @param {() => Promise<object|null>} [options.getPresence]
 * @param {() => object} [options.getGateFacts]
 * @param {(input: object) => Promise<object>} [options.materialize]
 * @param {(line: string) => void} [options.log]
 */
export function createProactiveRuntime({
  dir,
  clock = () => Date.now(),
  intervalMs = DEFAULT_PROACTIVE_TICK_MS,
  getPresence = async () => null,
  getGateFacts = () => ({}),
  materialize = async () => ({ ok: false, code: 'not-configured' }),
  initialSettings = {},
  log = () => {},
}) {
  if (!dir || typeof dir !== 'string') throw new TypeError('proactive dir required');
  const file = path.join(dir, PROACTIVE_STATE_FILE);
  const tickMs = Math.max(10_000, Math.min(3600_000, Number(intervalMs) || DEFAULT_PROACTIVE_TICK_MS));
  let state = createProactiveState(Number(clock()), initialSettings);
  let ready = null;
  let timer = null;
  let running = false;
  let stopped = false;
  let wakeTimer = null;

  function nowMs() {
    const value = Number(clock());
    return Number.isFinite(value) && value > 0 ? value : Date.now();
  }

  async function save() {
    const result = await writeJsonAtomic(file, state);
    if (!result.ok) safeLog(log, `[proactive] write failed code=${result.code || 'io-error'}`);
    return result;
  }

  ready = (async () => {
    const loaded = await readJson(file);
    if (loaded.ok) {
      state = normalizeProactiveState(loaded.value, nowMs());
    } else {
      state = createProactiveState(nowMs(), initialSettings);
      if (!loaded.missing) {
        safeLog(log, `[proactive] state read failed code=${loaded.code || 'io-error'}`);
      }
      await save();
    }
    return file;
  })();

  async function inspect() {
    await ready;
    const now = nowMs();
    const presence = await getPresence().catch(() => null);
    const facts = getGateFacts();
    const gate = evaluateProactiveGate({
      now,
      state,
      presence,
      ...(facts && typeof facts === 'object' ? facts : {}),
    });
    return { now, presence, facts, gate };
  }

  async function status() {
    const inspected = await inspect();
    const { gate } = inspected;
    return {
      schemaVersion: PROACTIVE_SCHEMA_VERSION,
      ...state.settings,
      ready: gate.allow,
      reason: gate.reason,
      quietNow: gate.quietNow,
      chatBound: gate.chatBound,
      petConnected: gate.petConnected,
      clientActive: gate.clientActive,
      busy: gate.busy,
      usedToday: gate.usedToday,
      idleSec: gate.idleSec,
      lastTriggeredAt: state.lastTriggeredAt,
      nextEligibleAt: gate.nextEligibleAt,
      checkedAt: inspected.now,
    };
  }

  async function tick() {
    if (stopped || running) return { ok: false, code: stopped ? 'stopped' : 'busy' };
    running = true;
    try {
      const inspected = await inspect();
      if (!inspected.gate.allow) {
        return { ok: false, code: inspected.gate.reason, gate: inspected.gate };
      }
      let delivered;
      try {
        delivered = await materialize(inspected);
      } catch (error) {
        delivered = {
          ok: false,
          code: (error && error.code) || 'materialize-failed',
        };
      }
      if (!delivered || delivered.ok !== true) {
        state.lastFailedAt = inspected.now;
        state.lastResult = String(delivered?.code || 'materialize-failed').slice(0, 80);
        await save();
        safeLog(log, `[proactive] delivery deferred code=${state.lastResult}`);
        return { ok: false, code: state.lastResult, gate: inspected.gate };
      }
      state.usage = {
        day: localDayKey(inspected.now, state.settings.timeZone),
        count: inspected.gate.usedToday + 1,
      };
      state.lastTriggeredAt = inspected.now;
      state.lastFailedAt = 0;
      state.lastResult = String(delivered.code || 'delivered').slice(0, 80);
      await save();
      safeLog(log, '[proactive] delivered');
      return { ok: true, at: inspected.now, gate: inspected.gate };
    } finally {
      running = false;
    }
  }

  function wake(delayMs = 0) {
    if (stopped) return;
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      tick().catch((error) => safeLog(log, `[proactive] tick failed ${error?.code || error?.name || 'Error'}`));
    }, Math.max(0, Number(delayMs) || 0));
    wakeTimer.unref?.();
  }

  function start({ immediate = false } = {}) {
    if (stopped || timer) return;
    timer = setInterval(() => {
      tick().catch((error) => safeLog(log, `[proactive] tick failed ${error?.code || error?.name || 'Error'}`));
    }, tickMs);
    timer.unref?.();
    if (immediate) wake(1000);
  }

  async function updateSettings(patch = {}) {
    await ready;
    const current = state.settings;
    state.settings = normalizeProactiveSettings({ ...current, ...(patch || {}) });
    const day = localDayKey(nowMs(), state.settings.timeZone);
    if (state.usage.day !== day) state.usage = { day, count: 0 };
    await save();
    if (state.settings.enabled) wake(250);
    return status();
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    if (wakeTimer) clearTimeout(wakeTimer);
    timer = null;
    wakeTimer = null;
    await save().catch(() => {});
  }

  return {
    file,
    ready,
    start,
    stop,
    wake,
    tick,
    status,
    updateSettings,
    settings() {
      return { ...state.settings };
    },
  };
}

