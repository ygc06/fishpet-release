/**
 * eventId 的唯一合同（R2 派工单 P0-2）。
 *
 * 为什么要有单独一个模块：`eventId` 同时出现在五个地方 —— 信封校验、账本结构校验、
 * commit 事务、索引写入、意图恢复。以前每处各写一半（有的只 trim、有的只查换行），
 * 于是 `"evt\nbad"` 能一路穿到索引写入才炸：state 已经写了、事件也追加了，索引那步
 * 失败，留下 `pending-commit.json`；重启恢复又栽在同一处，store 永久只读。
 *
 * 现在的规则：**一个 id 要么全链路合法，要么在第一道门就被拒**。合法 id 必须能被
 * 无损写进纯文本索引（一行一个），因此禁止任何会改变行结构的字符。
 *
 * @module dsh-fishpet-emotion/domain/event-id
 */

/** 账本既有上限：`validateLedgerRecord()` 一直用 200，这里保持一致。 */
export const EVENT_ID_MAX = 200;

/**
 * 控制字符：C0（含 CR/LF/TAB/NUL）、DEL、C1，以及 Unicode 行/段分隔符。
 * 它们都会破坏「一行一个 id」的纯文本索引。
 */
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

/** 孤立 UTF-16 surrogate：无法无损转 UTF-8，往返会变成替换字符。 */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * 校验一个 eventId。
 *
 * @param {unknown} value 候选 id。
 * @returns {{ok: true, id: string} | {ok: false, code: 'event-id-invalid', reason: string}}
 *   `ok:true` 时返回**已 trim** 的 id，调用方不要再自己 trim。
 */
export function checkEventId(value) {
  if (typeof value !== 'string') {
    return { ok: false, code: 'event-id-invalid', reason: 'not-string' };
  }
  const id = value.trim();
  if (!id) return { ok: false, code: 'event-id-invalid', reason: 'empty' };
  if (id.length > EVENT_ID_MAX) {
    return { ok: false, code: 'event-id-invalid', reason: 'too-long' };
  }
  if (CONTROL_RE.test(id)) {
    return { ok: false, code: 'event-id-invalid', reason: 'control-char' };
  }
  if (LONE_SURROGATE_RE.test(id) || !isWellFormed(id)) {
    return { ok: false, code: 'event-id-invalid', reason: 'not-well-formed' };
  }
  if (!utf8RoundTrips(id)) {
    return { ok: false, code: 'event-id-invalid', reason: 'not-utf8-lossless' };
  }
  return { ok: true, id };
}

/**
 * `String.prototype.isWellFormed` 在旧运行时可能不存在，兜底用正则判断。
 *
 * @param {string} value 候选字符串。
 * @returns {boolean} 是否是良构 UTF-16。
 */
function isWellFormed(value) {
  if (typeof value.isWellFormed === 'function') return value.isWellFormed();
  return !LONE_SURROGATE_RE.test(value);
}

/**
 * 真正写一次 UTF-8 往返：即便引擎的 isWellFormed 行为不同，这一步也能兜住
 * 「写进去再读出来不是同一个字符串」的 id。
 *
 * @param {string} value 候选字符串。
 * @returns {boolean} 往返是否无损。
 */
function utf8RoundTrips(value) {
  try {
    return Buffer.from(value, 'utf8').toString('utf8') === value;
  } catch {
    return false;
  }
}
