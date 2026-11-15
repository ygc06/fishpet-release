/**
 * 体力与硬约束。睡眠层当前按旧代码关闭，只保留惰性恢复和累到不许硬撑。
 *
 * @module dsh-fishpet-emotion/life/vitality
 */

import { chemReadout } from '../engine/state.js';
import { recentlySoothed, reparativeEvent, unresolvedAnger } from '../engine/anger.js';

export const LIFE_MARKER = '【身体】';
export const HARD_MARKER = '【硬性约束】';
export const ENERGY_START = 100;
export const COST_BASE = 0.45;
export const COST_LONG = 0.25;
export const COST_IMG = 0.4;
export const IDLE_RECOVER = 1.1;
export const RECOVER_AFTER = 180;
export const TIRED_LINE = 16;
export const STRAIN_LINE = 8;
export const SLEEP_LINE = 4;
export const HOT_BUDGET = 3;

export const STRAIN_LINES = Object.freeze(['累了。', '不想说。', '嗯。', '让我安静会儿。', '晚点再说。']);
export const GOODBYE_LINES = Object.freeze([
  '眼皮打架了…我先眯一会儿，你别走开。',
  '撑不住了，脑子转不动。等我醒。',
  '真的困了，让我靠一会儿，明天接着跟你闹。',
  '不行了，我得躺一下。你要还在，就等我。',
]);

/**
 * @returns {object}
 */
export function createVitalityState() {
  return {
    version: 1,
    energy: ENERGY_START,
    sleeping: false,
    sleep_at: 0,
    sleep_until: 0,
    turns: 0,
    last_turn_at: 0,
    last_recover_at: 0,
    wakes: 0,
    epiphanies: [],
    closed_loops: [],
    last_epiphany_at: 0,
    epi_day: '',
    epi_day_count: 0,
  };
}

/**
 * 惰性恢复：空闲够久就按分钟补体力。
 *
 * @param {object} input
 * @param {number} now
 * @returns {{state: object, event: string|null}}
 */
export function refreshVitality(input, now) {
  const data = normalize(input);
  data.energy = clampEnergy(data.energy ?? ENERGY_START);
  data.sleeping = false;
  const base = Math.max(Number(data.last_turn_at || 0), Number(data.last_recover_at || 0));
  if (base && now - base >= RECOVER_AFTER) {
    const elapsed = Math.min(now - base, 6 * 3600);
    const gain = elapsed / 60 * IDLE_RECOVER;
    if (gain > 0.2) {
      data.energy = clampEnergy(Number(data.energy) + gain);
      data.last_recover_at = now;
    }
  }
  return { state: data, event: null };
}

/**
 * @param {object} input
 * @param {number} now
 * @param {string} text
 * @param {boolean} hasImage
 * @returns {{state: object, cost: number}}
 */
export function spendVitality(input, now, text = '', hasImage = false) {
  const data = normalize(input);
  let cost = COST_BASE;
  if (String(text || '').length > 40) cost += COST_LONG;
  if (hasImage) cost += COST_IMG;
  data.energy = clampEnergy(Number(data.energy) - cost);
  data.turns = Number(data.turns || 0) + 1;
  data.last_turn_at = now;
  if (data.energy <= SLEEP_LINE && !data.sleeping) {
    data.sleeping = false;
    data.sleep_at = now;
    data.sleep_until = now + 4 * 3600;
  }
  return { state: data, cost };
}

/**
 * 调模型前先决定这一轮能不能答。
 *
 * @param {object} input
 * @param {number} now
 * @param {string} text
 * @param {boolean} isOwner
 * @param {boolean} hot
 * @param {() => number} random
 * @returns {{state: object, mode: string, block: boolean, text: string, event: string|null}}
 */
export function gateVitality(input, now, text, isOwner, hot = false, random = () => 0.5) {
  const refreshed = refreshVitality(input, now);
  const data = refreshed.state;
  const energy = Number(data.energy);
  if (hot && energy > SLEEP_LINE) {
    const budget = Number(data.hot_budget ?? HOT_BUDGET);
    if (budget > 0) {
      data.hot_budget = budget - 1;
      return { state: data, mode: 'hot', block: false, text: '', event: refreshed.event };
    }
  }
  if (energy <= STRAIN_LINE) {
    if (!data.said_goodbye) {
      data.said_goodbye = true;
      return {
        state: data,
        mode: 'strain',
        block: true,
        text: pick(GOODBYE_LINES, random),
        event: refreshed.event,
      };
    }
    if (Number(random()) < 0.5) {
      return { state: data, mode: 'strain', block: true, text: pick(STRAIN_LINES, random), event: refreshed.event };
    }
    return { state: data, mode: 'strain', block: false, text: '', event: refreshed.event };
  }
  if (energy > TIRED_LINE + 10) {
    data.hot_budget = HOT_BUDGET;
    delete data.said_goodbye;
  }
  if (energy <= TIRED_LINE) return { state: data, mode: 'tired', block: false, text: '', event: refreshed.event };
  if (refreshed.event === 'woke') return { state: data, mode: 'woke', block: false, text: '', event: refreshed.event };
  return { state: data, mode: 'ok', block: false, text: '', event: refreshed.event };
}

/**
 * @param {object} input
 * @param {number} now
 * @returns {string}
 */
export function renderVitality(input, now) {
  const data = normalize(input);
  const energy = Number(data.energy);
  let feel;
  if (energy <= STRAIN_LINE) feel = '你几乎没力气了，头也沉，只想安静躺着。';
  else if (energy <= TIRED_LINE) feel = '你很累，懒得动，说话都嫌费劲。';
  else if (energy <= 45) feel = '你有点乏，不算难受，但不想讲太多。';
  else if (energy >= 80) feel = '你精神挺好，身上有劲。';
  else feel = '你还行，不算累。';
  const last = Number(data.last_turn_at || 0);
  const extra = last && now - last > 6 * 3600 ? '好久没人跟你说话了，你有点闷。' : '';
  return `${LIFE_MARKER}\n${feel}${extra}说话带着它，不用解释原因；累的时候可以少贫嘴，别把状态抹平。`;
}

/**
 * @param {object} input
 * @param {object} mood
 * @param {number} now
 * @param {string} text
 * @param {object[]} scars
 * @param {string} [eventType]
 * @returns {string}
 */
export function hardDirective(input, mood, now, text, scars, eventType = '') {
  const data = normalize(input);
  const rules = [];
  const energy = Number(data.energy);
  if (energy <= STRAIN_LINE) {
    rules.push('体力见底：最多回 6 个字，能一个词就一个词；不解释、不哄、不提问。');
  } else if (energy <= TIRED_LINE) {
    rules.push('很累：最多一句话、12 个字内；不主动开新话题；不想答的就敷衍过去。');
  }
  const chem = chemReadout(mood || {});
  const explicitlyRepairing = /(对不起|我错了|是我错|我不该|抱歉)/.test(String(text || ''));
  const angerHeld = unresolvedAnger(mood, mood, now) && !reparativeEvent(eventType) && !explicitlyRepairing;
  if (angerHeld) {
    rules.push(
      '你正在发火，不是受委屈：直接说清他哪句话踩了线，语气要硬、句子短，可以顶回去；' +
      '不许委屈巴巴、不许示弱撒娇、不许求抱求哄，也不许把一句夸奖当成台阶。'
    );
  } else if (chem.cortisol >= 85 && !recentlySoothed(mood, now)) rules.push('你正在火头上：话短、硬、带刺；不许哄人、不许长篇解释；最多两小句。');
  else if (chem.cortisol >= 60) rules.push('你有点烦：话变少，不主动延伸话题。');
  if (chem.serotonin <= 20) rules.push('你情绪很低：平淡、少解释、别主动开新话题。');
  else if (chem.serotonin <= 35) rules.push('你情绪偏低：别太热情。');
  if (chem.dopamine >= 80 && !rules.length) rules.push('你正高兴：可以多接一句、可以主动岔开聊点别的，但别刷屏。');
  const scar = matchScar(text, scars);
  if (scar) {
    rules.push(
      `他碰到了你的疤「${scar.topic || ''}」：先顿一下（用省略号或一句短的），` +
      '别顺着这个聊，绕开或者嘴硬顶回去；不解释为什么不想聊。'
    );
  }
  if (!rules.length) return '';
  rules.push('上面这些是身体和情绪的硬约束，必须照做；不许报数字、不许说激素、不许解释机制。');
  return HARD_MARKER + '\n' + rules.map((rule) => '- ' + rule).join('\n');
}

/**
 * @param {string} text
 * @param {object[]} scars
 * @returns {object|null}
 */
export function matchScar(text, scars) {
  const normalized = String(text || '').replace(/\s+/g, '').toLowerCase();
  if (!normalized) return null;
  let best = null;
  for (const scar of Array.isArray(scars) ? scars : []) {
    const core = String(scar.core || scar.topic || '').replace(/\s+/g, '').toLowerCase();
    if (core.length >= 2 && normalized.includes(core)) {
      scar.hits = Number(scar.hits || 0) + 1;
      best = scar;
    }
  }
  return best;
}

/**
 * @param {string} text
 * @param {object} input
 * @param {number} now
 * @returns {string}
 */
export function shapeOutput(text, input, now) {
  const out = String(text || '').trim();
  if (!out) return out;
  const energy = Number(normalize(input).energy);
  let limit = 0;
  if (energy <= STRAIN_LINE) limit = 30;
  else if (energy <= TIRED_LINE) limit = 60;
  return limit && out.length > limit ? trim(out, limit) : out;
}

/**
 * @param {object} input
 * @param {number} now
 * @returns {boolean}
 */
export function epiphanyAllowed(input, now) {
  const data = normalize(input);
  const last = Number(data.last_epiphany_at || 0);
  if (last && now - last < 10 * 3600) return false;
  if (data.epi_day === dayKey(now) && Number(data.epi_day_count || 0) >= 2) return false;
  return true;
}

/**
 * @param {object} input
 * @param {string} text
 * @param {number} now
 * @returns {object|null}
 */
export function applyEpiphany(input, text, now) {
  const data = normalize(input);
  const value = String(text || '').trim().replace(/^["“”]+|["“”]+$/g, '');
  if (value.length < 6) return null;
  const item = { id: Math.trunc(now * 1000), text: value.slice(0, 120), at: now, used: false };
  data.epiphanies.push(item);
  data.epiphanies = data.epiphanies.slice(-6);
  data.last_epiphany_at = now;
  const day = dayKey(now);
  if (data.epi_day !== day) {
    data.epi_day = day;
    data.epi_day_count = 0;
  }
  data.epi_day_count = Number(data.epi_day_count || 0) + 1;
  return item;
}

/**
 * @param {object} input
 * @param {number} now
 * @returns {object|null}
 */
export function pendingEpiphany(input, now) {
  return normalize(input).epiphanies.find((item) => !item.used && now - Number(item.at || 0) < 3 * 86400) || null;
}

/**
 * @param {object} input
 * @param {number} id
 * @returns {boolean}
 */
export function markEpiphanyUsed(input, id) {
  const item = normalize(input).epiphanies.find((entry) => Number(entry.id) === Number(id));
  if (!item) return false;
  item.used = true;
  return true;
}

/**
 * @param {object} input
 * @param {number} now
 * @returns {string}
 */
export function renderEpiphany(input, now) {
  const item = pendingEpiphany(input, now);
  if (!item) return '';
  return `【刚想通的事】\n你睡醒后脑子里转着这句话：「${item.text}」\n（如果有合适的机会，可以自然提一句；别解释这条记录是怎么来的。）`;
}

/**
 * @param {object} input
 * @returns {object}
 */
export function vitalitySnapshot(input) {
  const data = normalize(input);
  const energy = Number(data.energy);
  return {
    energy: round(energy, 1),
    state: energy <= STRAIN_LINE ? '快没力气' : energy <= TIRED_LINE ? '很累' : energy <= 45 ? '有点乏' : '有精神',
    sleeping: Boolean(data.sleeping),
    turns: Number(data.turns || 0),
    sleep_until: Number(data.sleep_until || 0),
    epiphanies: data.epiphanies.length,
    closed_loops: data.closed_loops.length,
  };
}

/**
 * @param {object} scar
 * @param {number} now
 * @returns {object}
 */
export function closeScar(scar, now) {
  scar.closed_at = now;
  return scar;
}

function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return createVitalityState();
  if (!Array.isArray(input.epiphanies)) input.epiphanies = [];
  if (!Array.isArray(input.closed_loops)) input.closed_loops = [];
  return input;
}

function clampEnergy(value) {
  return Math.max(0, Math.min(100, Number(value)));
}

function pick(items, random) {
  return items[Math.min(items.length - 1, Math.max(0, Math.floor(Number(random()) * items.length)))];
}

function trim(text, limit) {
  const head = text.slice(0, limit);
  for (const separator of ['。', '！', '？', '…', '\n', '，']) {
    const index = head.lastIndexOf(separator);
    if (index >= Math.max(4, Math.floor(limit / 2))) return text.slice(0, index + 1).trim();
  }
  return head.trim();
}

function dayKey(seconds) {
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
