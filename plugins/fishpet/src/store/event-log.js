/**
 * `events.jsonl` 的追加日志：内存幂等集合 + fdatasync + 按大小轮转。
 *
 * 轮转规则：当前文件超过 `maxBytes`（默认 2 MiB）时，先改名为 `events.<n>.jsonl`，
 * 再写新行；只保留最近 3 个轮转文件。轮转不清空内存里的 eventId 集合，
 * 因此同一进程内 `hasEventId` 对已轮转的 id 仍然为 true。
 *
 * @module dsh-fishpet-emotion/store/event-log
 */

import { promises as nodeFs } from 'node:fs';
import path from 'node:path';
import { errorCode } from './atomic-json.js';
import { SCHEMA_VERSION, validateLedgerRecord } from './schema-v1.js';

/** 当前账本文件名。 */
export const EVENTS_FILE = 'events.jsonl';

/** 轮转文件名正则。 */
export const ROTATED_PATTERN = /^events\.(\d+)\.jsonl$/;

/** 单文件上限：2 MiB。 */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** 保留的轮转文件个数。 */
export const KEEP_ROTATED = 3;

/**
 * @typedef {object} EventLog
 * @property {() => Promise<{ok: boolean, missing?: boolean, corrupt?: boolean, schemaMismatch?: boolean, code?: string, line?: number}>} init
 * @property {(record: {eventId: string}, line: string) => Promise<{ok: boolean, code?: string}>} append
 * @property {(eventId: string) => boolean} has
 * @property {() => number} size
 */

/**
 * @param {{dir: string, fs?: object, log?: (line: string) => void, maxBytes?: number}} options
 * @returns {EventLog}
 */
export function createEventLog(options) {
  const dir = options.dir;
  const fs = options.fs || nodeFs;
  const logSource = typeof options.log === 'function' ? options.log : () => {};
  const log = (line) => {
    try {
      logSource(line);
    } catch {
      /* ignore logger failure */
    }
  };
  const configured = Number(options.maxBytes);
  const maxBytes = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_BYTES;
  const file = path.join(dir, EVENTS_FILE);

  /** @type {Set<string>} */
  const ids = new Set();
  let bytes = 0;

  async function prune(knownNumbers) {
    const sorted = Array.from(new Set(knownNumbers)).sort((a, b) => b - a);
    const keep = new Set(sorted.slice(0, KEEP_ROTATED));
    for (const number of sorted) {
      if (keep.has(number)) continue;
      try {
        await fs.unlink(path.join(dir, 'events.' + number + '.jsonl'));
      } catch {
        /* 单个旧文件删不掉不影响写入 */
      }
    }
  }

  async function rotate(knownNumbers) {
    let numbers = knownNumbers;
    if (!numbers) {
      numbers = [];
      try {
        const names = await fs.readdir(dir);
        for (const name of names) {
          const match = ROTATED_PATTERN.exec(name);
          if (match) numbers.push(Number(match[1]));
        }
      } catch (error) {
        return { ok: false, code: errorCode(error) };
      }
    }
    const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
    try {
      await fs.rename(file, path.join(dir, 'events.' + next + '.jsonl'));
    } catch (error) {
      return { ok: false, code: errorCode(error) };
    }
    bytes = 0;
    await prune(numbers.concat(next));
    log('emotion-store: rotate file=events.' + next + '.jsonl');
    return { ok: true };
  }

  async function listLedgerFiles() {
    const names = await fs.readdir(dir);
    const rotated = [];
    for (const name of names) {
      const match = ROTATED_PATTERN.exec(name);
      if (match) rotated.push({ name, number: Number(match[1]) });
    }
    rotated.sort((left, right) => left.number - right.number);
    const kept = rotated.slice(-KEEP_ROTATED).map((item) => item.name);
    const files = [];
    if (names.includes(EVENTS_FILE)) files.push(EVENTS_FILE);
    return files.concat(kept);
  }

  return {
    async init() {
      ids.clear();
      bytes = 0;
      let files;
      try {
        files = await listLedgerFiles();
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return { ok: true, missing: true, files: [] };
        return { ok: false, corrupt: true, code: 'events.bad-line', reason: 'unreadable' };
      }
      if (!files.length) return { ok: true, missing: true, files: [] };

      for (const name of files) {
        let text;
        try {
          text = await fs.readFile(path.join(dir, name), 'utf8');
        } catch (error) {
          if (errorCode(error) === 'ENOENT') continue;
          return { ok: false, corrupt: true, code: 'events.bad-line', file: name, reason: 'unreadable' };
        }
        const body = String(text);
        if (!body) continue;
        if (name === EVENTS_FILE) bytes = Buffer.byteLength(body, 'utf8');

        // 最后一行没有换行符 = 上次写到一半被杀；按契约只报告，不截断、不修复。
        const tornTail = !body.endsWith('\n');
        const lines = body.split('\n');
        const complete = tornTail ? lines.slice(0, lines.length - 1) : lines;

        for (let index = 0; index < complete.length; index += 1) {
          const line = complete[index].trim();
          if (!line) continue;
          let record;
          try {
            record = JSON.parse(line);
          } catch {
            return { ok: false, corrupt: true, code: 'events.bad-line', file: name, line: index + 1 };
          }
          if (!record || typeof record !== 'object' || Array.isArray(record)) {
            return { ok: false, corrupt: true, code: 'events.bad-line', file: name, line: index + 1 };
          }
          if (record.schemaVersion !== SCHEMA_VERSION) {
            return { ok: false, schemaMismatch: true, code: 'schema-mismatch', file: name, line: index + 1 };
          }
          // 账本不只是 eventId 容器：结构损坏的旧行同样必须进只读，
          // 不能因为 ID 看起来可用就把它当成可继续写入的合法历史。
          if (!validateLedgerRecord(record).ok) {
            return { ok: false, corrupt: true, code: 'events.bad-line', file: name, line: index + 1 };
          }
          ids.add(record.eventId);
        }

        if (tornTail) {
          return {
            ok: false,
            tornTail: true,
            code: 'events.torn-tail',
            file: name,
            line: complete.length + 1,
          };
        }
      }
      return { ok: true, missing: !files.includes(EVENTS_FILE), files };
    },

    async append(record, line) {
      const text = line.endsWith('\n') ? line : line + '\n';
      try {
        const stat = await fs.stat(file);
        bytes = Number(stat.size) || 0;
      } catch {
        bytes = 0;
      }
      if (bytes > maxBytes) {
        const rotated = await rotate();
        if (!rotated.ok) return rotated;
      }

      /** @type {import('node:fs/promises').FileHandle | null} */
      let handle = null;
      try {
        handle = await fs.open(file, 'a', 0o600);
        await handle.writeFile(text, 'utf8');
        if (typeof handle.datasync === 'function') {
          try {
            await handle.datasync();
          } catch {
            await handle.sync();
          }
        } else {
          await handle.sync();
        }
        await handle.close();
        handle = null;
        bytes += Buffer.byteLength(text, 'utf8');
        ids.add(record.eventId);
        if (bytes > maxBytes) {
          const rotated = await rotate();
          if (!rotated.ok) log('emotion-store: rotate deferred code=' + rotated.code);
        }
        return { ok: true };
      } catch (error) {
        if (handle) {
          try {
            await handle.close();
          } catch {
            /* ignore */
          }
        }
        return { ok: false, code: errorCode(error) };
      }
    },

    has(eventId) {
      return ids.has(String(eventId));
    },

    /** 供启动对账把仍保留在滚动日志里的 id 补进长期索引；日常去重走 event-index。 */
    ids() {
      return Array.from(ids);
    },

    size() {
      return ids.size;
    },
  };
}
