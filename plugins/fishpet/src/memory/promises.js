/**
 * 承诺：她说出口、还没做到的事。到期提醒，但不假装后台一直在执行。
 *
 * @module dsh-fishpet-emotion/memory/promises
 */

export const PROMISE_MARKER = '【答应过的事】';
export const MAX_PROMISES = 30;
export const DUE_WINDOW = 3 * 86400;

const DAY = 86400;
const DUE_MAP = Object.freeze({
  今晚: 6 * 3600,
  明天: DAY,
  后天: 2 * DAY,
  周末: 3 * DAY,
  下周: 7 * DAY,
});

/**
 * @returns {{version: number, next_id: number, promises: object[]}}
 */
export function createPromiseState() {
  return { version: 1, next_id: 1, promises: [] };
}

/**
 * @param {object} input
 * @param {object} args
 * @returns {object|null}
 */
export function addPromise(input, args = {}) {
  const data = normalizeState(input);
  const now = Number(args.now);
  const text = cleanPromise(args.what).slice(0, 40);
  if (text.length < 4) return null;
  const key = normalizePromise(text);
  if (data.promises.some((item) => normalizePromise(item.text || '') === key)) return null;
  const delta = DUE_MAP[String(args.due || '').trim()];
  const id = Number(data.next_id || 1);
  data.next_id = id + 1;
  const item = {
    id,
    text,
    raw: '',
    source: String(args.source || 'model'),
    created_at: now,
    due_at: delta ? now + delta : 0,
    done: false,
    mentioned_at: 0,
  };
  data.promises.push(item);
  if (data.promises.length > MAX_PROMISES) {
    data.promises.sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0));
    data.promises.splice(0, data.promises.length - MAX_PROMISES);
  }
  return item;
}

/**
 * @param {object} input
 * @returns {object[]}
 */
export function activePromises(input) {
  return normalizeState(input).promises.filter((item) => !item.done);
}

/**
 * @param {object} input
 * @param {number} now
 * @returns {object[]}
 */
export function duePromises(input, now) {
  return activePromises(input).filter((item) => {
    const at = Number(item.due_at || 0);
    return at && at <= now && !item.mentioned_at;
  });
}

/**
 * @param {object} input
 * @param {number} now
 * @returns {object[]}
 */
export function upcomingPromises(input, now) {
  return activePromises(input).filter((item) => {
    const at = Number(item.due_at || 0);
    return now < at && at <= now + DUE_WINDOW;
  });
}

/**
 * @param {object} input
 * @param {number} now
 * @returns {string}
 */
export function renderPromises(input, now) {
  const due = duePromises(input, now);
  const upcoming = upcomingPromises(input, now);
  if (!due.length && !upcoming.length) return '';
  const lines = [PROMISE_MARKER];
  if (due.length) {
    lines.push('你答应过、到现在还没兑现的事：');
    for (const item of due.slice(0, 4)) {
      const late = (now - Number(item.due_at || now)) / 3600;
      lines.push(`- ${item.text || ''}（逾期 ${roundHours(late)} 小时）`);
    }
    lines.push('提到相关话题时要自己认下来，别装没这回事；可以解释、可以补，但不许含糊过去。');
  }
  if (upcoming.length) {
    lines.push('你最近答应过的事（记着）：');
    for (const item of upcoming.slice(0, 4)) {
      const left = (Number(item.due_at || now) - now) / 3600;
      lines.push(`- ${item.text || ''}（还有 ${roundHours(left)} 小时）`);
    }
  }
  return lines.join('\n');
}

/**
 * @param {object} input
 * @param {number|string} id
 * @param {number} now
 * @returns {boolean}
 */
export function markPromiseMentioned(input, id, now) {
  const item = normalizeState(input).promises.find((entry) => Number(entry.id) === Number(id));
  if (!item) return false;
  item.mentioned_at = now;
  return true;
}

/**
 * @param {object} input
 * @param {number|string} id
 * @param {object} args
 * @returns {boolean}
 */
export function notePromiseAsk(input, id, args = {}) {
  const item = normalizeState(input).promises.find((entry) => Number(entry.id) === Number(id));
  if (!item) return false;
  const note = String(args.note || '').trim().slice(0, 40);
  item.asks = Number(item.asks || 0) + 1;
  item.last_ask_at = Number(args.now);
  if (note) item.last_note = note;
  if (args.answered) {
    item.answered_at = Number(args.now);
    if (note) item.answer = note;
    item.settled_at = Number(args.now);
  }
  return true;
}

/**
 * @param {object} input
 * @param {number|string} id
 * @param {number} now
 * @returns {boolean}
 */
export function completePromise(input, id, now) {
  const item = normalizeState(input).promises.find((entry) => Number(entry.id) === Number(id));
  if (!item) return false;
  item.done = true;
  item.done_at = now;
  return true;
}

/**
 * @param {object} input
 * @param {number|string} id
 * @returns {boolean}
 */
export function forgetPromise(input, id) {
  const data = normalizeState(input);
  const before = data.promises.length;
  data.promises = data.promises.filter((item) => Number(item.id) !== Number(id));
  return data.promises.length !== before;
}

/**
 * @param {object} input
 * @param {number} now
 * @returns {object|null}
 */
export function pickPromiseForShare(input, now) {
  const item = duePromises(input, now)[0];
  if (!item) return null;
  return {
    id: item.id,
    text: `答应过你的事：${item.text || ''}`,
    created_at: item.created_at || now,
  };
}

function normalizeState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return createPromiseState();
  if (!Array.isArray(input.promises)) input.promises = [];
  if (!Number.isFinite(Number(input.next_id))) input.next_id = 1;
  return input;
}

function cleanPromise(text) {
  let value = String(text || '').replace(/[「」“”‘’"'']/g, '').replace(/\s+/g, '');
  value = value.replace(/^[，,。.！!？?~～… ]+|[，,。.！!？?~～… ]+$/g, '');
  for (let i = 0; i < 2; i += 1) {
    value = value.replace(/(行吧|好不好|成吗|可以吗|对吧|好不好嘛|嘛|呀|啊|了|吧)$/g, '');
    value = value.replace(/^[，,。.！!？?~～… ]+|[，,。.！!？?~～… ]+$/g, '');
  }
  return value;
}

function normalizePromise(text) {
  return String(text || '').replace(/[\s，,。.！!？?~～…]/g, '');
}

/**
 * 对齐旧 Python 的 `:.0f`：整数取整，恰好半小时时取偶数。
 *
 * @param {number} value
 * @returns {number}
 */
function roundHours(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const floor = Math.floor(number);
  const fraction = number - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}
