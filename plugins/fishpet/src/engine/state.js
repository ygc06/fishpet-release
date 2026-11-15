/**
 * 六轴情绪、时间衰减、好感与信任读数的原生实现。
 *
 * 行为对齐旧 `core_state.py`。所有公开函数都接收时间参数，不读取系统时钟；
 * 仍直接改入参，但会先复制，保证调用方拿到的旧快照不被改写。
 *
 * 内部量程允许 valence 到 ±120，对外展示钳到 ±100。
 *
 * @module dsh-fishpet-emotion/engine/state
 */

export const LAYER2_SCHEMA_VERSION = 2;

export const MOOD_BASELINE = Object.freeze({
  valence: 10,
  energy: 65,
  arousal: 0,
  cling_base: 35,
});

export const MOOD_LIMITS = Object.freeze({
  valence: Object.freeze([-120, 120]),
  energy: Object.freeze([0, 100]),
  arousal: Object.freeze([-100, 100]),
  dominance: Object.freeze([-100, 100]),
  cling_adj: Object.freeze([-20, 60]),
  trust: Object.freeze([-50, 100]),
});

export const EXTREME_BOUNDS = Object.freeze({
  valence: Object.freeze([-85, 85]),
  clingy: Object.freeze([-18, 55]),
  energy: Object.freeze([-Infinity, Infinity]),
  arousal: Object.freeze([-Infinity, Infinity]),
  dominance: Object.freeze([-Infinity, Infinity]),
});

/** 爆发态衰减减速系数。 */
export const BURST_SLOW = 0.35;
export const DECAY_PER_HOUR = Object.freeze({
  valence: 3,
  energy: 30,
  arousal: 18,
  dominance: 12,
  cling_adj: 5,
});

export const CLING_HOME = 0;
export const CLING_SILENT_AFTER = 2;
export const CLING_SILENT_RATE = 6;
export const CLING_SILENT_CAP = 12;

export const AFFINITY_BASE = 30;
export const AFFINITY_DAILY_GAIN_CAP = 6;
export const AFFINITY_IDLE_GRACE_DAYS = 7;
export const AFFINITY_IDLE_DECAY_PER_DAY = 1;

export const PRAISE_WORDS = Object.freeze([
  '厉害', '可爱', '好棒', '爱你', '想你', '抱抱', '摸摸', '亲亲', '乖', '辛苦',
  '谢谢', '喜欢你', '做得不错', '好看', '好听', '聪明', '宝贝', '棒', '想你了',
]);

export const INSULT_WORDS = Object.freeze([
  '滚', '闭嘴', '烦死', '蠢', '笨', '讨厌', '别烦', '不理你', '垃圾', '废物',
  '傻', '走开', '烦人',
]);

/**
 * @param {unknown} value
 * @param {number} [low]
 * @param {number} [high]
 * @returns {number}
 */
export function clamp(value, low = 0, high = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return low;
  return Math.max(low, Math.min(high, n));
}

/**
 * @param {number} value
 * @param {number} target
 * @param {number} step
 * @returns {number}
 */
export function toward(value, target, step) {
  if (value > target) return Math.max(target, value - Math.abs(step));
  if (value < target) return Math.min(target, value + Math.abs(step));
  return value;
}

/**
 * 本地日期键，和旧 `time.strftime("%Y-%m-%d", localtime())` 一致。
 *
 * @param {number} now Unix 秒。
 * @returns {string}
 */
export function localDayKey(now) {
  const date = new Date(Number(now) * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * @param {number} [now] Unix 秒。
 * @returns {object}
 */
export function createMoodState(now = Date.now() / 1000) {
  const stamp = Number.isFinite(Number(now)) ? Number(now) : 0;
  return {
    valence: MOOD_BASELINE.valence,
    energy: MOOD_BASELINE.energy,
    arousal: MOOD_BASELINE.arousal,
    valence_base: MOOD_BASELINE.valence,
    cling_adj: 0,
    dominance: 0,
    trust: 10,
    trust_at: 0,
    updated_at: stamp,
    last_user_msg_at: 0,
    last_emo: '',
    last_impulse: 0,
    episode_tail: 1,
    surge: null,
    day: localDayKey(stamp),
    day_msgs: 0,
    regress: 0,
    neg_streak: 0,
    reg_cool: 99,
    extreme: { items: [], keys: [], new_items: [], label: '', new_label: '', at: 0 },
  };
}

/**
 * @param {unknown} text
 * @returns {{valence: number, clingy: number, affinity: number}}
 */
export function analyzeText(text) {
  const said = String(text ?? '');
  const praise = PRAISE_WORDS.some((word) => said.includes(word));
  const insult = INSULT_WORDS.some((word) => said.includes(word));
  if (insult) return { valence: -7, clingy: -1, affinity: -3.5 };
  if (praise) return { valence: 4, clingy: 2, affinity: 1.2 };
  return { valence: 0.5, clingy: 0, affinity: 0.35 };
}

/**
 * 推力越大，反应层留得越久；情绪词不参与。
 *
 * @param {unknown} magnitude
 * @returns {number}
 */
export function impulseFactor(magnitude) {
  const n = Math.abs(Number(magnitude) || 0);
  if (n <= 5) return 0.6;
  if (n <= 12) return 1.5;
  if (n <= 20) return 3;
  if (n <= 30) return 5;
  return 8;
}

/**
 * @param {'valence'|'energy'|'arousal'|'clingy'|'dominance'} key
 * @param {number} value
 * @returns {number}
 */
function burstSlow(key, value) {
  const bounds = EXTREME_BOUNDS[key];
  if (!bounds || !Number.isFinite(bounds[0]) || !Number.isFinite(bounds[1])) return 1;
  return value > bounds[1] || value < bounds[0] ? BURST_SLOW : 1;
}

/**
 * 按经过时间把状态拉回基线。
 *
 * @param {object} input 当前心情。
 * @param {number} now Unix 秒。
 * @param {{incoming?: boolean}} [options]
 * @returns {object} 新状态。
 */
export function decayMood(input, now, options = {}) {
  const data = { ...(input || {}) };
  const target = Number(now);
  if (!Number.isFinite(target)) return data;
  const hours = (target - Number(data.updated_at ?? target)) / 3600;

  const currentValence = Number(data.valence ?? MOOD_BASELINE.valence);
  const currentBase = Number(data.valence_base ?? MOOD_BASELINE.valence);
  const deviation = Math.abs(currentValence - currentBase);
  let factor = Math.max(
    impulseFactor(data.last_impulse),
    Math.min(4, 0.6 + deviation / 25)
  );

  if (data.surge && target - Number(data.surge.at || 0) < 1800) {
    factor = Math.min(factor, 1);
  }
  factor *= Math.max(1, Math.min(1.6, Number(data.episode_tail || 1)));
  const trust = Number(data.trust ?? 10);
  factor *= Math.max(1, Math.min(1.8, 1 + Math.max(0, -trust) / 100 * 0.8));

  if (hours > 0) {
    let base = toward(currentBase, MOOD_BASELINE.valence, 8 * hours);
    const slow = burstSlow('valence', currentValence);
    const initialReaction = currentValence - base;
    const tau = 1800 * factor * (initialReaction > 0 ? 1.6 : 0.8) / Math.max(0.15, slow);
    const reaction = initialReaction * Math.exp(-hours * 3600 / tau);
    const reactedValence = base + reaction;
    const alpha = (1 - Math.exp(-hours / (3 * factor))) * 0.5 * slow;
    const beforeBase = base;
    base = base * (1 - alpha) + reactedValence * alpha;
    base = Math.max(beforeBase - 10, Math.min(beforeBase + 10, base));
    data.valence_base = round(clamp(base, -120, 120), 2);
    data.valence = round(
      clamp(data.valence_base + (reactedValence - base) * (1 - alpha), -120, 120),
      2
    );

    const energy = Number(data.energy ?? MOOD_BASELINE.energy);
    data.energy = toward(energy, MOOD_BASELINE.energy, DECAY_PER_HOUR.energy * hours * burstSlow('energy', energy));

    const arousal = Number(data.arousal ?? MOOD_BASELINE.arousal);
    data.arousal = toward(arousal, MOOD_BASELINE.arousal, DECAY_PER_HOUR.arousal * hours * burstSlow('arousal', arousal));

    const dominance = Number(data.dominance ?? 0);
    data.dominance = toward(dominance, 0, DECAY_PER_HOUR.dominance * hours);

    const adj = Number(data.cling_adj ?? 0);
    const adjBurst = burstSlow('clingy', MOOD_BASELINE.cling_base + adj);
    let home = CLING_HOME;
    const lastUser = Number(data.last_user_msg_at || 0);
    if (lastUser && options.incoming !== true) {
      const silentHours = Math.max(0, (target - lastUser) / 3600);
      if (silentHours > CLING_SILENT_AFTER) {
        home += Math.min(CLING_SILENT_CAP, CLING_SILENT_RATE * (silentHours - CLING_SILENT_AFTER));
      }
    }
    data.cling_adj = toward(adj, home, DECAY_PER_HOUR.cling_adj * hours * adjBurst);
  }

  data.updated_at = target;
  const day = localDayKey(target);
  if (data.day !== day) {
    data.day = day;
    data.day_msgs = 0;
  }
  return data;
}

/**
 * 收到一条消息：先按时间衰减，再算聊天成本和文本粗规则。
 *
 * @param {object} input 当前心情。
 * @param {number} now Unix 秒。
 * @param {unknown} text 原话（只在私有状态内使用）。
 * @param {{isGroup?: boolean, textDriven?: boolean}} [options]
 * @returns {object}
 */
export function applyMessage(input, now, text, options = {}) {
  const data = decayMood(input, now, { incoming: true });
  const said = String(text ?? '');
  const words = options.textDriven === false ? { valence: 0, clingy: 0 } : analyzeText(said);
  const hour = new Date(Number(now) * 1000).getHours();

  data.valence = clamp(Number(data.valence ?? 10) + words.valence, -100, 100);
  let drain = options.isGroup ? 0.25 : 0.55;
  drain += Math.min(0.9, said.length * 0.012);
  if (hour >= 0 && hour < 6) drain += 1.2;
  data.energy = clamp(Number(data.energy ?? 65) - drain, 0, 100);
  data.cling_adj = clamp(Number(data.cling_adj ?? 0) + words.clingy, -20, 60);
  data.last_user_msg_at = Number(now);
  data.day_msgs = Number(data.day_msgs || 0) + 1;
  return data;
}

/**
 * @param {object} input
 * @param {number} now Unix 秒。
 * @returns {object}
 */
export function moodView(input, now) {
  const data = input || {};
  const lastUser = Number(data.last_user_msg_at || 0);
  const silentHours = lastUser ? Math.max(0, (Number(now) - lastUser) / 3600) : 0;
  return {
    valence: clamp(Number(data.valence ?? 10), -100, 100),
    energy: clamp(Number(data.energy ?? 65)),
    arousal: clamp(Number(data.arousal ?? 0), -100, 100),
    dominance: clamp(Number(data.dominance ?? 0), -100, 100),
    clinginess: clamp(MOOD_BASELINE.cling_base + Number(data.cling_adj ?? 0)),
    trust: clamp(Number(data.trust ?? 10), -50, 100),
    silent_hours: silentHours,
    day_msgs: Number(data.day_msgs || 0),
  };
}

/**
 * @param {object} view
 * @returns {Record<string, string>}
 */
export function moodLabels(view) {
  const v = Number(view.valence);
  const e = Number(view.energy);
  const a = Number(view.arousal);
  const c = Number(view.clinginess);
  const valence = v <= -40 ? '很差' : v <= -10 ? '不太好' : v < 20 ? '平静' : v < 50 ? '不错' : '很好';
  const energy = e < 20 ? '快没电了' : e < 45 ? '有点累' : e < 75 ? '正常' : '精神';
  const arousal = a < -40 ? '很安静' : a < -10 ? '有点低' : a < 20 ? '平常' : a < 50 ? '有点上头' : '很激动';
  const clinginess = c < 25 ? '想一个人待着' : c < 50 ? '正常' : c < 75 ? '有点黏' : '很想被理';
  return { valence, energy, arousal, clinginess };
}

/**
 * @returns {{users: Record<string, object>}}
 */
export function createAffinityState() {
  return { users: {} };
}

/**
 * @param {number} score
 * @returns {'陌生'|'眼熟'|'朋友'|'亲近'|'重要的人'}
 */
export function affinityLevel(score) {
  const n = Number(score);
  if (n < 20) return '陌生';
  if (n < 40) return '眼熟';
  if (n < 60) return '朋友';
  if (n < 80) return '亲近';
  return '重要的人';
}

/**
 * 更新单个 actor 的好感；身份键只存在私有状态里。
 *
 * @param {object} input
 * @param {string} actorId
 * @param {number} now Unix 秒。
 * @param {{name?: string, text?: string, floors?: Record<string, number>, textDriven?: boolean, delta?: number}} [options]
 * @returns {{state: object, record: object, delta: number}}
 */
export function touchAffinity(input, actorId, now, options = {}) {
  const data = {
    ...(input || {}),
    users: { ...(((input || {}).users) || {}) },
  };
  const id = String(actorId ?? '');
  if (!id) throw new TypeError('actorId required');
  let record = data.users[id];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    record = {
      name: options.name || id,
      score: AFFINITY_BASE,
      first_seen: now,
      last_seen: now,
      msgs: 0,
      gain_day: localDayKey(now),
      gain_today: 0,
    };
  } else {
    record = { ...record };
  }

  const lastSeen = Number(record.last_seen ?? now);
  const idleDays = (Number(now) - lastSeen) / 86400;
  if (idleDays > AFFINITY_IDLE_GRACE_DAYS) {
    const loss = (idleDays - AFFINITY_IDLE_GRACE_DAYS) * AFFINITY_IDLE_DECAY_PER_DAY;
    record.score = clamp(Number(record.score ?? AFFINITY_BASE) - loss);
  }

  const day = localDayKey(now);
  if (record.gain_day !== day) {
    record.gain_day = day;
    record.gain_today = 0;
  }
  const before = Number(record.score ?? AFFINITY_BASE);
  const suppliedDelta = Number(options.delta);
  const textDelta = options.delta !== undefined
    ? (Number.isFinite(suppliedDelta) ? suppliedDelta : 0)
    : options.textDriven === false
      ? 0
      : analyzeText(options.text || '').affinity;
  let delta = textDelta;
  if (textDelta > 0) {
    const room = Math.max(0, AFFINITY_DAILY_GAIN_CAP - Number(record.gain_today || 0));
    delta = Math.min(textDelta, room);
    record.gain_today = Number(record.gain_today || 0) + Math.max(0, delta);
  }
  const floor = Number((options.floors || {})[id] || 0);
  record.score = round(clamp(Math.max(before + delta, floor)), 2);
  record.last_seen = now;
  record.msgs = Number(record.msgs || 0) + 1;
  if (options.name) record.name = options.name;
  data.users[id] = record;
  return { state: data, record: { ...record }, delta: record.score - before };
}

/**
 * @param {object|null|undefined} record
 * @returns {object|null}
 */
export function affinityView(record) {
  if (!record || typeof record !== 'object') return null;
  const score = Number(record.score ?? AFFINITY_BASE);
  return {
    name: record.name || '对方',
    score,
    level: affinityLevel(score),
    msgs: Number(record.msgs || 0),
  };
}

/**
 * 递质读数只由当前心情和唤醒换算，不单独持久化。
 *
 * @param {object} mood
 * @returns {{dopamine: number, cortisol: number, serotonin: number}}
 */
export function chemReadout(mood) {
  const v = clamp(Number(mood?.valence || 0), -100, 100);
  const arousal = clamp(Number(mood?.arousal || 0), -100, 100);
  return {
    dopamine: round(clamp(50 + v * 0.4 + arousal * 0.3), 1),
    cortisol: round(clamp(50 + arousal * 0.5), 1),
    serotonin: round(clamp(50 + v * 0.5), 1),
  };
}

/**
 * @param {number} value
 * @param {number} [digits]
 * @returns {number}
 */
function round(value, digits = 0) {
  const scale = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
}
