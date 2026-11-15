/**
 * 永不轮转的 eventId 去重索引。
 *
 * 索引分成两个独立文件，格式由文件名而不是行内容决定：
 *
 * | 文件 | 代际 | 读取规则 | 写入 |
 * | --- | --- | --- | --- |
 * | `event-ids.log` | R2 旧索引 | 每个非空行就是一条原始 eventId | 永不写入 |
 * | `event-ids.v2.log` | R4 新索引 | 每行必须是严格 `v2:<base64url>` | 只追加这里 |
 *
 * 旧文件字节是不可变历史证据。即使旧 id 恰好以 `v2:` 或 `{` 开头，也仍然按字面
 * eventId 解释，绝不根据单行形状猜测格式。读取时合并两代集合；因此同一个 id 同时
 * 出现在两个文件中时只算一次。
 *
 * v2 行使用 base64url 编码，严格检查 canonical base64url、UTF-8 回环和 eventId 合同。
 * 旧文件中的非法字面行或 v2 文件中的任何坏行都代表“已消费但身份不可确认”，
 * 调用方必须进入只读故障态，不能跳过该行后放行重放。
 *
 * @module dsh-fishpet-emotion/store/event-index
 */

import { promises as nodeFs } from 'node:fs';
import { Buffer } from 'node:buffer';
import { errorCode } from './atomic-json.js';
import { checkEventId } from '../domain/event-id.js';

/** R2 旧索引：一行一个原始 eventId，只读。 */
export const LEGACY_EVENT_INDEX_FILE = 'event-ids.log';

/** R4 新索引：一行一个严格 v2 编码 id，只追加。 */
export const EVENT_INDEX_FILE = 'event-ids.v2.log';

/** 语义更明确的别名；值始终与当前写入文件一致。 */
export const EVENT_INDEX_V2_FILE = EVENT_INDEX_FILE;

/** 新行前缀。升到 v3 时应换独立文件名，不要在同一个文件里靠行形状猜。 */
export const EVENT_INDEX_PREFIX = 'v2:';

/**
 * 把 eventId 编码成一行（不含换行符）。
 *
 * @param {string} eventId 已通过 `checkEventId` 的 id。
 * @returns {string} `v2:<base64url>`。
 */
export function encodeIndexLine(eventId) {
  return EVENT_INDEX_PREFIX + Buffer.from(String(eventId), 'utf8').toString('base64url');
}

/**
 * 解 v2 行。严格模式：base64url 必须回环、UTF-8 必须回环、id 必须合合同。
 *
 * @param {string} line 已去掉行结束符的单行。
 * @returns {{ok: true, id: string} | {ok: false, reason: string}} 结果。
 */
export function decodeIndexLine(line) {
  if (!String(line).startsWith(EVENT_INDEX_PREFIX)) {
    return { ok: false, reason: 'missing-prefix' };
  }
  const payload = line.slice(EVENT_INDEX_PREFIX.length);
  if (!payload) return { ok: false, reason: 'empty-payload' };
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return { ok: false, reason: 'bad-base64url' };
  let bytes;
  try {
    bytes = Buffer.from(payload, 'base64url');
  } catch {
    return { ok: false, reason: 'bad-base64url' };
  }
  if (!bytes.length) return { ok: false, reason: 'bad-base64url' };
  // Node 的 base64url 解码是宽松的；回环保证这一行确实是我们写出的 canonical 格式。
  if (bytes.toString('base64url') !== payload) {
    return { ok: false, reason: 'not-canonical' };
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return { ok: false, reason: 'bad-utf8' };
  const check = checkEventId(text);
  if (!check.ok) return { ok: false, reason: check.reason };
  if (check.id !== text) return { ok: false, reason: 'noncanonical-id' };
  return { ok: true, id: check.id };
}

/**
 * 把文件文本拆成带行号的非空行；只把 CRLF 的 CR 当作行结束符，不 trim 内容。
 *
 * @param {unknown} text 文件文本。
 * @returns {{line: string, lineNo: number}[]} 原始行。
 */
function nonEmptyLines(text) {
  const lines = String(text).split('\n');
  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === '') continue;
    out.push({ line, lineNo: index + 1 });
  }
  return out;
}

/**
 * 读取一个索引文件，ENOENT 是可预期的缺省状态。
 *
 * @param {object} fs 文件系统实现。
 * @param {string} file 文件路径。
 * @returns {Promise<{missing: boolean, text?: string}>} 读取结果。
 */
async function readIndexFile(fs, file) {
  try {
    return { missing: false, text: await fs.readFile(file, 'utf8') };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { missing: true };
    throw Object.assign(new Error('event index read failed'), {
      code: errorCode(error),
      file,
    });
  }
}

/**
 * @typedef {object} EventIndexIssue
 * @property {string} file 出问题的索引文件名。
 * @property {number} line 行号。
 * @property {string} reason 稳定原因码。
 */

/**
 * @typedef {object} EventIndex
 * @property {string} file v2 索引文件路径。
 * @property {string} legacyFile 旧索引文件路径。
 * @property {() => Promise<Set<string>>} load 重建两代合并集合。
 * @property {(eventId: string) => boolean} has 查合并集合。
 * @property {(eventId: string) => Promise<{ok: boolean, duplicate?: boolean, code?: string}>} append 只追加 v2。
 * @property {number} size 合并集合大小。
 * @property {EventIndexIssue[]} issues 最近一次 load 的坏行。
 * @property {boolean} missing 两代文件都不存在。
 * @property {boolean} legacyMissing 旧文件不存在。
 * @property {boolean} versionMissing v2 文件不存在。
 * @property {boolean} corrupt 最近一次 load 是否读到无法确定 id 的行。
 * @property {number} legacy 最近一次 load 读到的旧文件非空行数。
 * @property {string} unreadableFile 最近一次读文件失败时，失败的是哪一代。
 */

/**
 * @param {{file: string, legacyFile: string, fs?: object}} options
 * @returns {EventIndex}
 */
export function openEventIndex(options) {
  const file = options.file;
  const legacyFile = options.legacyFile;
  const fs = options.fs || nodeFs;
  /** @type {Set<string>} */
  const ids = new Set();
  /** @type {EventIndexIssue[]} */
  let issues = [];
  let missing = false;
  let legacyMissing = false;
  let versionMissing = false;
  let corrupt = false;
  let legacy = 0;
  let unreadableFile = '';

  return {
    file,
    legacyFile,

    async load() {
      ids.clear();
      issues = [];
      missing = false;
      legacyMissing = false;
      versionMissing = false;
      corrupt = false;
      legacy = 0;
      unreadableFile = '';

      let oldRead;
      let newRead;
      try {
        [oldRead, newRead] = await Promise.all([
          readIndexFile(fs, legacyFile),
          readIndexFile(fs, file),
        ]);
      } catch (error) {
        unreadableFile = (error && error.file) || file;
        throw error;
      }
      legacyMissing = oldRead.missing;
      versionMissing = newRead.missing;
      missing = legacyMissing && versionMissing;

      if (!oldRead.missing) {
        for (const { line, lineNo } of nonEmptyLines(oldRead.text)) {
          legacy += 1;
          // 文件级代际已经确定为 R2：整行就是字面 id，不解析 JSON，不解 v2 前缀。
          const check = checkEventId(line);
          if (!check.ok || check.id !== line) {
            issues.push({
              file: legacyFile,
              line: lineNo,
              reason: 'bad-legacy:' + (check.ok ? 'noncanonical-id' : check.reason),
            });
            corrupt = true;
            continue;
          }
          ids.add(line);
        }
      }

      if (!newRead.missing) {
        for (const { line, lineNo } of nonEmptyLines(newRead.text)) {
          // 文件级代际已经确定为 v2：这里不接受裸 id 或 JSONL 形状。
          if (!line.startsWith(EVENT_INDEX_PREFIX)) {
            issues.push({
              file,
              line: lineNo,
              reason: 'bad-v2:missing-prefix',
            });
            corrupt = true;
            continue;
          }
          const decoded = decodeIndexLine(line);
          if (!decoded.ok) {
            // 读不出 id 的 v2 行可能代表已消费事件，绝不能当作“不存在”。
            issues.push({
              file,
              line: lineNo,
              reason: 'bad-v2:' + decoded.reason,
            });
            corrupt = true;
            continue;
          }
          ids.add(decoded.id);
        }
      }
      return new Set(ids);
    },

    has(eventId) {
      return ids.has(String(eventId));
    },

    async append(eventId) {
      const check = checkEventId(eventId);
      if (!check.ok) return { ok: false, code: 'invalid-id', reason: check.reason };
      const key = check.id;
      if (ids.has(key)) return { ok: false, duplicate: true };

      /** @type {import('node:fs/promises').FileHandle | null} */
      let handle = null;
      try {
        // 只追加新代际文件；旧 event-ids.log 永不创建、截断或改写。
        handle = await fs.open(file, 'a', 0o600);
        await handle.writeFile(encodeIndexLine(key) + '\n', 'utf8');
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
        ids.add(key);
        versionMissing = false;
        missing = false;
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

    get size() {
      return ids.size;
    },

    get issues() {
      return issues;
    },

    get missing() {
      return missing;
    },

    get legacyMissing() {
      return legacyMissing;
    },

    get versionMissing() {
      return versionMissing;
    },

    get corrupt() {
      return corrupt;
    },

    get legacy() {
      return legacy;
    },

    get unreadableFile() {
      return unreadableFile;
    },
  };
}
