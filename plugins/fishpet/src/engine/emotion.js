/**
 * PAD 表达层：离散标签快速衰减，只影响语气，不接管判断。
 *
 * @module dsh-fishpet-emotion/engine/emotion
 */

export const PAD_DEFAULT = Object.freeze({ p: 0.05, a: 0.35, d: 0.5 });
export const MASK_THRESHOLD = 0.25;
export const SOFTEN_WINDOW = 900;
export const LABEL_HALF_LIFE_MIN = 45;
export const MOOD_HALF_LIFE_H = 6;

const HINTS = Object.freeze({
  开心: '语气轻快一点，可以多接一句',
  生气: '句子短一点，别主动找话题，但别骂人',
  难过: '别装开心，话少一点',
  害怕: '别硬撑，可以示弱一句',
  委屈: '别主动讨好，等对方先解释',
  害羞: '可以嘴硬一句，别顺着说太多',
  得意: '可以显摆一句，别过头',
  感动: '语气软一点，记着这份好',
  焦虑: '别催对方，先把自己这句话说清楚',
  无聊: '可以主动找个话题，别刷屏',
});

function clean(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 确保对象里有合法 pad；不修改原对象。
 *
 * @param {object} input
 * @returns {object}
 */
function withPad(input) {
  const data = { ...(input || {}) };
  const raw = data.pad && typeof data.pad === 'object' && !Array.isArray(data.pad)
    ? { ...data.pad }
    : {};
  const labels = raw.labels && typeof raw.labels === 'object' && !Array.isArray(raw.labels)
    ? { ...raw.labels }
    : {};
  data.pad = {
    ...PAD_DEFAULT,
    labels: {},
    trigger: '',
    at: 0,
    ...raw,
    labels,
  };
  return data;
}

/**
 * @param {object} input
 * @param {number} now Unix 秒。
 * @returns {object}
 */
export function decayEmotion(input, now) {
  const data = withPad(input);
  const pad = data.pad;
  const last = Number(pad.at || 0);
  if (!last) {
    pad.at = now;
    return data;
  }
  const minutes = Math.max(0, (Number(now) - last) / 60);
  if (minutes <= 0) return data;

  const labelFactor = 0.5 ** (minutes / LABEL_HALF_LIFE_MIN);
  for (const [name, value] of Object.entries(pad.labels)) {
    const next = round(Number(value) * labelFactor, 3);
    if (next < 0.02) delete pad.labels[name];
    else pad.labels[name] = next;
  }
  const moodFactor = 0.5 ** (minutes / 60 / MOOD_HALF_LIFE_H);
  for (const key of ['p', 'a', 'd']) {
    pad[key] = PAD_DEFAULT[key] + (Number(pad[key]) - PAD_DEFAULT[key]) * moodFactor;
  }
  pad.at = Number(now);
  return data;
}

/**
 * 记下“刚被哄”的时间；表达层据此让她晚一点彻底松下来。
 *
 * @param {object} input
 * @param {number} now Unix 秒。
 * @returns {object}
 */
export function sootheEmotion(input, now) {
  const data = withPad(input);
  data.pad.soothed_at = Number(now);
  return data;
}

/**
 * @param {object} input
 * @returns {{name: string, score: number}}
 */
export function topLabel(input) {
  const data = withPad(input);
  const entries = Object.entries(data.pad.labels);
  if (!entries.length) return { name: '', score: 0 };
  entries.sort((a, b) => Number(b[1]) - Number(a[1]));
  return { name: entries[0][0], score: Number(entries[0][1]) };
}

/**
 * @param {object} input
 * @returns {string}
 */
export function describeEmotion(input) {
  const data = withPad(input);
  const top = topLabel(data);
  if (top.score < 0.12) return '';
  const trigger = clean(data.pad.trigger).slice(0, 24);
  const level = top.score < 0.3 ? '有点' : top.score < 0.5 ? '挺' : '很';
  return `${level}${top.name}（${top.score.toFixed(1)}）${trigger ? `，因为「${trigger}」` : ''}`;
}

/**
 * @param {object} input
 * @param {number} [now] Unix 秒。
 * @returns {string}
 */
export function regulationLines(input, now = Date.now() / 1000) {
  const data = withPad(input);
  const labels = data.pad.labels;
  const negative = Math.max(
    ...['生气', '委屈', '难过'].map((name) => Number(labels[name] || 0)),
    0
  );
  const lines = [];
  if (negative >= MASK_THRESHOLD) {
    lines.push('可以嘴硬：说“没事”“随便”，句尾带一点刺也行；但别真的装开心，也别主动求和。');
  }
  const soothed = Number(data.pad.soothed_at || 0);
  if (soothed && now - soothed < SOFTEN_WINDOW && negative > 0.05) {
    lines.push('刚被哄，拉不下脸，别马上说“没事”；撑一两轮，语气松一点就行。');
  }
  if (lines.length) {
    lines.push('不能用情绪拿捏对方：不威胁、不冷战惩罚、不反复翻旧账换道歉。');
  }
  return lines.join('\n');
}

/**
 * @param {object} input
 * @returns {string}
 */
export function emotionHint(input) {
  const top = topLabel(input);
  if (top.score < 0.12) return '';
  const base = HINTS[top.name] || '';
  if (!base) return '';
  return base + '。情绪只影响语气，不影响判断；对方要你做事就正常做，不要主动提自己的情绪。';
}

/**
 * 把本轮由模型自由写出的情绪词记账。
 *
 * 这里不把词映射成固定轴：词只决定“她认为这股劲叫什么”，强度由本轮
 * 心情变化决定。相同词会增强，旧的词保留到自然衰减；最多保留 8 个，
 * 防止自由文本把状态文件撑大。
 *
 * @param {object} input 当前 emotion 状态。
 * @param {{feelings?: string[], trigger?: string, at: number, intensity?: number}} args
 * @returns {object} 新状态，不修改入参。
 */
export function touchEmotion(input, args = {}) {
  const data = decayEmotion(withPad(input), Number(args.at || 0));
  const pad = data.pad;
  const intensity = Math.max(0, Math.min(1, Number(args.intensity || 0)));
  const strength = Math.round((0.2 + intensity * 0.4) * 1000) / 1000;
  const words = [...new Set(
    (Array.isArray(args.feelings) ? args.feelings : [])
      .map((word) => clean(word).slice(0, 12))
      .filter(Boolean)
  )];
  for (const word of words) {
    pad.labels[word] = Math.min(0.6, Number(pad.labels[word] || 0) + strength);
  }
  const ranked = Object.entries(pad.labels)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 8);
  pad.labels = Object.fromEntries(ranked);
  pad.trigger = clean(args.trigger).slice(0, 24);
  pad.at = Number(args.at || 0);
  return data;
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
