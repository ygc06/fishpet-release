/**
 * 识海：被明确要求“永远记住”的长期条目。
 *
 * @module dsh-fishpet-emotion/memory/core-memory
 */

export const CORE_MARKER = '【识海 · 永不遗忘】';
export const CORE_MAX_TEXT = 300;
export const CORE_MAX_INJECT = 2400;

export const CORE_TRIGGERS = Object.freeze([
  '永远记住',
  '永远记着',
  '永远记得',
  '永远都记得',
  '永远不忘',
  '永远别忘',
  '永远不要忘',
  '永远不能忘',
  '一直记住',
  '一辈子记住',
  '一辈子都记住',
  '一辈子别忘',
  '一辈子都不能忘',
  '记一辈子',
  '记得一辈子',
  '不许忘',
  '不能忘',
]);

/**
 * @returns {{version: number, updated_at: number, entries: object[], next_id: number}}
 */
export function createCoreMemoryState() {
  return { version: 1, updated_at: 0, entries: [], next_id: 1 };
}

/**
 * @param {unknown} text
 * @param {readonly string[]} [triggers]
 * @returns {string|null}
 */
export function extractCoreTrigger(text, triggers = CORE_TRIGGERS) {
  const raw = String(text || '');
  for (const trigger of triggers) {
    const index = raw.indexOf(trigger);
    if (index < 0) continue;
    const core = raw.slice(index + trigger.length).replace(/^[，,。.：:；;、!！?？ \n\t]+/, '').trim();
    return core.length >= 3 ? core : null;
  }
  return null;
}

/**
 * @param {object} input
 * @param {object} args
 * @returns {{state: object, item: object|null, created: boolean}}
 */
export function addCoreMemory(input, args = {}) {
  const data = normalizeState(input);
  let text = String(args.text || '').replace(/\s+/g, ' ').trim().replace(/^[，,。.；;：: ]+|[，,。.；;：: ]+$/g, '');
  if (text.length < 2) return { state: data, item: null, created: false };
  text = text.slice(0, CORE_MAX_TEXT);
  const norm = normalizeCore(text);
  if (!norm) return { state: data, item: null, created: false };
  const existing = data.entries.find((entry) => entry.status !== 'deleted' && normalizeCore(entry.text || '') === norm);
  if (existing) return { state: data, item: existing, created: false };
  const id = Number(data.next_id || 1);
  const item = {
    id,
    text,
    by: String(args.by || ''),
    by_id: String(args.byId || ''),
    source: String(args.source || ''),
    importance: 1,
    status: 'active',
    created_at: Number(args.now || 0),
    created_date: dayKey(Number(args.now || 0)),
  };
  data.entries.push(item);
  data.next_id = id + 1;
  data.updated_at = Number(args.now || 0);
  return { state: data, item, created: true };
}

/**
 * @param {object} input
 * @param {number|string} id
 * @param {number} now
 * @returns {boolean}
 */
export function deleteCoreMemory(input, id, now) {
  const item = normalizeState(input).entries.find((entry) =>
    Number(entry.id) === Number(id) && (entry.status || 'active') === 'active'
  );
  if (!item) return false;
  item.status = 'deleted';
  item.deleted_at = Number(now);
  return true;
}

/**
 * @param {object} input
 * @param {number} maxChars
 * @returns {string}
 */
export function formatCoreMemory(input, maxChars = CORE_MAX_INJECT) {
  const active = normalizeState(input).entries.filter((entry) => (entry.status || 'active') === 'active');
  if (!active.length) return '';
  const rule = '以下内容是被授权的人亲口要你永远记住的，和人格同级：永不衰减、永不删除、不许否认、不许擅自改。群聊里不要复述，也不要拿来透露别人的私事。';
  let used = CORE_MARKER.length + rule.length;
  const lines = [];
  let dropped = 0;
  active.forEach((entry, index) => {
    const line = `${index + 1}. [${entry.created_date || ''} ${entry.by || ''}] ${entry.text || ''}`;
    if (used + line.length + 1 > maxChars) {
      dropped += 1;
      return;
    }
    used += line.length + 1;
    lines.push(line);
  });
  let block = `${CORE_MARKER}\n${rule}\n${lines.join('\n')}`;
  if (dropped) block += `\n（还有 ${dropped} 条识海记忆因字数预算没展开，需要时用 /识海 查看）`;
  return block;
}

function normalizeState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return createCoreMemoryState();
  if (!Array.isArray(input.entries)) input.entries = [];
  if (!Number.isFinite(Number(input.next_id))) {
    const maxId = Math.max(0, ...input.entries.map((entry) => Number(entry.id || 0)));
    input.next_id = maxId + 1;
  }
  return input;
}

function normalizeCore(text) {
  return String(text || '').replace(/[\s\p{P}\p{S}_]+/gu, '').toLowerCase();
}

function dayKey(seconds) {
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
