/**
 * 情绪调节：重解释、压住、转移，以及压住后的反弹。
 *
 * @module dsh-fishpet-emotion/engine/regulation
 */

export const REGULATION_LINES = Object.freeze({
  重解释: '你正在自己给自己找台阶——他大概不是故意的，犯不着往心里去，但心里那点不舒服还在，不会一下就没事。',
  压住: '你在压着：这会儿不适合发火，先咽下去——可这事没完，你记着，只是现在不说。',
  转移: '你不想再在这件事上耗了，索性岔开话题，或者给自己找点别的事做——但没解决的那部分还挂着。',
});

const HURT_WORDS = Object.freeze(['委屈', '失望', '闷', '气']);

/**
 * @param {object} input
 * @returns {string|null}
 */
export function pickRegulation({
  v,
  arousal,
  emo,
  affinity,
  negativeStreak,
  energy,
  base = 10,
  coolDown = 99,
}) {
  if (coolDown < 2) return null;
  if (Number(v) >= Number(base) - 18) return null;
  if (Number(energy) <= 20) return null;
  if (String(emo || '') === '怕') return null;
  if (Number(v) <= -80) return Number(arousal) >= 55 ? '压住' : '重解释';

  const intensity = Math.max(Math.abs(Number(v)) / 100, Number(arousal) / 100);
  if (intensity >= 0.65) return Number(arousal) >= 65 ? '转移' : '压住';
  if (Number(affinity) >= 55 && HURT_WORDS.some((word) => String(emo || '').includes(word))) {
    return '重解释';
  }
  if (Number(arousal) >= 55) return '压住';
  return null;
}

/**
 * @param {string} strategy
 * @param {object} input
 * @returns {{mood: object, summary: object}}
 */
export function applyRegulation(strategy, input) {
  const mood = { ...(input || {}) };
  const beforeV = Number(mood.valence ?? 0);
  const beforeA = Number(mood.arousal ?? 20);
  if (strategy === '重解释') {
    mood.valence = round(beforeV + (0 - beforeV) * 0.35, 1);
    mood.arousal = round(clamp(beforeA - 8, -100, 100), 1);
    mood.regress = 0;
  } else if (strategy === '压住') {
    mood.arousal = round(clamp(beforeA - 3, -100, 100), 1);
    mood.regress = Number(mood.regress || 0) + 1;
  } else if (strategy === '转移') {
    mood.valence = round(Math.min(100, beforeV + 4), 1);
    mood.arousal = round(clamp(beforeA - 6, -100, 100), 1);
    mood.regress = 0;
  } else {
    return { mood: input, summary: {} };
  }
  return {
    mood,
    summary: {
      strategy,
      valence: [round(beforeV, 1), round(Number(mood.valence || 0), 1)],
      arousal: [round(beforeA, 1), round(Number(mood.arousal || 0), 1)],
      regress: Number(mood.regress || 0),
    },
  };
}

/**
 * @param {object} input
 * @returns {{mood: object, summary: object|null}}
 */
export function reboundRegulation(input) {
  const mood = { ...(input || {}) };
  const times = Number(mood.regress || 0);
  if (times <= 0) return { mood, summary: null };
  const beforeV = Number(mood.valence || 0);
  const beforeA = Number(mood.arousal || 0);
  mood.valence = round(Math.max(-100, beforeV - 3 * times), 1);
  mood.arousal = round(Math.min(100, beforeA + 4 * times), 1);
  mood.regress = 0;
  return {
    mood,
    summary: {
      times,
      valence: [round(beforeV, 1), round(Number(mood.valence || 0), 1)],
      arousal: [round(beforeA, 1), round(Number(mood.arousal || 0), 1)],
    },
  };
}

/**
 * @param {string|null} strategy
 * @returns {string}
 */
export function regulationLine(strategy) {
  return REGULATION_LINES[String(strategy || '')] || '';
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
