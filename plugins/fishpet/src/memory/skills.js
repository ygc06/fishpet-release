/**
 * 程序记忆：带明确指令前缀的规矩，之后在相关话题里照做。
 *
 * @module dsh-fishpet-emotion/memory/skills
 */

export const SKILL_MARKER = '【学到的规矩】';
export const MAX_RULES = 40;

const PATTERNS = Object.freeze([
  /(?:以后|之后|下次|每次|从今以后|今后)(都|要|得|别|不要|别再|不许|不准)?([^。！？!?\n]{2,26})/g,
  /(?:你应该|你得|你要先|你要|记住|记住了|别忘|不许你|不准你)[，,]?([^。！？!?\n]{2,26})/g,
]);

const STOP_WORDS = Object.freeze([
  '别烦我', '别理我', '别跟我', '别管我', '别问我', '别告诉我', '别来烦',
  '闭嘴', '伤心', '生气', '难过', '哭', '往心里去', '关掉', '放弃你', '黏人',
  '好不好', '行不行', '走开', '滚', '讨厌', '受不了',
]);

/**
 * @returns {{version: number, next_id: number, rules: object[]}}
 */
export function createSkillState() {
  return { version: 1, next_id: 1, rules: [] };
}

/**
 * @param {object} input
 * @param {string} text
 * @param {number} now
 * @returns {object|null} 最后新增的一条；重复或不合格返回 null。
 */
export function captureSkill(input, text, now) {
  const data = normalizeState(input);
  const raw = String(text || '');
  if (raw.length < 4 || raw.length > 300) return null;
  const found = [];
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of raw.matchAll(pattern)) {
      let piece = '';
      if (match[1] !== undefined || match[2] !== undefined) {
        const negative = String(match[1] || '').trim();
        const body = clean(match[2]);
        piece = ['别', '不要', '别再'].includes(negative) ? '别' + body : body;
      }
      if (piece.length < 2 || piece.length > 28) continue;
      if (STOP_WORDS.some((word) => piece.includes(word))) continue;
      found.push(piece);
    }
  }
  if (!found.length) return null;
  const unique = [];
  for (const candidate of found.sort((a, b) => b.length - a.length)) {
    if (unique.some((kept) => kept.includes(candidate))) continue;
    unique.push(candidate);
  }
  const existing = new Set(data.rules.map((item) => normalize(item.rule || '')));
  let added = null;
  for (const piece of unique) {
    const key = normalize(piece);
    if (!key || existing.has(key)) continue;
    added = { id: Number(data.next_id || 1), rule: piece, created_at: now, hits: 0 };
    data.next_id = added.id + 1;
    data.rules.push(added);
    existing.add(key);
  }
  if (data.rules.length > MAX_RULES) {
    data.rules.sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0));
    data.rules.splice(0, data.rules.length - MAX_RULES);
  }
  return added;
}

/**
 * @param {object} input
 * @param {string} text
 * @param {number} limit
 * @returns {object[]}
 */
export function relevantSkills(input, text, limit = 3) {
  const data = normalizeState(input);
  const rules = data.rules.filter((item) => item.rule);
  if (!rules.length) return [];
  const words = bigrams(text || '');
  const scored = rules.map((rule) => {
    const ruleWords = bigrams(rule.rule || '');
    let overlap = 0;
    for (const word of words) if (ruleWords.has(word)) overlap += 1;
    return { overlap, hits: Number(rule.hits || 0), created: Number(rule.created_at || 0), rule };
  });
  scored.sort((a, b) => b.overlap - a.overlap || b.hits - a.hits || b.created - a.created);
  if (scored[0]?.overlap === 0) scored.sort((a, b) => b.created - a.created);
  return scored.slice(0, limit).map((entry) => entry.rule);
}

/**
 * @param {object} input
 * @param {string} text
 * @returns {string}
 */
export function renderSkills(input, text = '') {
  const picks = relevantSkills(input, text, 3);
  if (!picks.length) return '';
  return [
    SKILL_MARKER,
    '他定过的规矩，这次也照做：',
    ...picks.map((item) => `- ${item.rule || ''}`),
    '不要复述这些规矩，直接体现在做法里；跟你此刻的口风冲突时，用你此刻的语气去守它——规矩管的是做什么，不管你怎么说。',
  ].join('\n');
}

/**
 * @param {object} input
 * @param {number|string} id
 * @returns {boolean}
 */
export function forgetSkill(input, id) {
  const data = normalizeState(input);
  const before = data.rules.length;
  data.rules = data.rules.filter((item) => Number(item.id) !== Number(id));
  return before !== data.rules.length;
}

function normalizeState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return createSkillState();
  if (!Array.isArray(input.rules)) input.rules = [];
  if (!Number.isFinite(Number(input.next_id))) input.next_id = 1;
  return input;
}

function normalize(text) {
  return String(text || '').replace(/[\s，,。.！!？?~～…「」“”"']/g, '');
}

function clean(text) {
  return String(text || '').replace(/\s+/g, '').replace(/^[，,。.！!？?~～… ]+|[，,。.！!？?~～… ]+$/g, '');
}

function bigrams(text) {
  const value = normalize(text);
  const out = new Set();
  for (let i = 0; i < Math.max(0, value.length - 1); i += 1) out.add(value.slice(i, i + 2));
  return out;
}
