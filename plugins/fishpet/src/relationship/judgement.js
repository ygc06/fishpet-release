/**
 * 慢层判断：“他是个什么人”不是每轮重猜，只有轴真的挪够了才改口。
 *
 * @module dsh-fishpet-emotion/relationship/judgement
 */

export const MIN_TRUST_DRIFT = 8;
export const MIN_CLING_DRIFT = 18;

const BAD_WORDS = Object.freeze(['阈', '轴', '分数', '数值', '系统', '模型', '判定', '触发', '本轮']);

/**
 * @param {unknown} text
 * @param {number} limit
 * @returns {string}
 */
export function clipJudgement(text, limit = 40) {
  let value = String(text || '').replace(/\s+/g, '');
  if (!value) return '';
  if (/[0-9０-９]/.test(value)) return '';
  if (BAD_WORDS.some((word) => value.includes(word))) return '';
  if (value.length > limit) value = value.slice(0, limit).replace(/[，。；、 ]+$/g, '');
  return value;
}

/**
 * @param {unknown} old
 * @param {number} trust
 * @param {number} clingy
 * @returns {number}
 */
export function judgementDrift(old, trust, clingy) {
  if (!old || typeof old !== 'object' || !old.text) return Infinity;
  const dt = Math.abs(Number(trust) - Number(old.trust || 0));
  const dc = Math.abs(Number(clingy) - Number(old.clingy || 0));
  return Math.max(dt, dc * (MIN_TRUST_DRIFT / MIN_CLING_DRIFT));
}

/**
 * @param {unknown} old
 * @param {unknown} newText
 * @param {number} trust
 * @param {number} clingy
 * @returns {{update: boolean, reason: string, drift: number}}
 */
export function shouldUpdateJudgement(old, newText, trust, clingy) {
  const text = clipJudgement(newText);
  if (!text) return { update: false, reason: '没写新看法', drift: 0 };
  if (old && typeof old === 'object' && text === String(old.text || '')) {
    return { update: false, reason: '和上次一模一样', drift: 0 };
  }
  const distance = judgementDrift(old, trust, clingy);
  if (distance >= MIN_TRUST_DRIFT) {
    return { update: true, reason: `轴挪够了（${distance.toFixed(1)}）`, drift: distance };
  }
  return {
    update: false,
    reason: `轴还没挪够（${distance.toFixed(1)}）——先记着，看法不动`,
    drift: distance,
  };
}

/**
 * @param {unknown} old
 * @returns {string}
 */
export function judgementLine(old) {
  if (!old || typeof old !== 'object') return '';
  const text = String(old.text || '').trim();
  return text ? '【我对他这个人的看法】' + text : '';
}
