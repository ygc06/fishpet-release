/**
 * “火还没消”的统一判定。
 *
 * 高唤醒的负向情绪不能只被描述成委屈、发闷或求哄。近期仍有刺伤、数值仍处在
 * 高怒区间，或极端状态仍锁着“炸了”时，都视为未解决愤怒；只有明确的修复事件
 * 才能提前解除这层惯性。
 *
 * @module dsh-fishpet-emotion/engine/anger
 */

import { activeExpressionSignals } from './expression-signals.js';

const HOT_LABEL = /(生气|发火|火大|来气|恼火|愤怒|不服气|炸了|绷住了)/;
const SOOTHE_WINDOW = 20 * 60;

/**
 * @param {object} mood
 * @param {number} [now]
 * @returns {boolean}
 */
export function recentlySoothed(mood = {}, now = Date.now() / 1000) {
  const at = Number(mood?.pad?.soothed_at || 0);
  const stamp = Number(now);
  return at > 0 && Number.isFinite(stamp) && stamp >= at && stamp - at < SOOTHE_WINDOW;
}

/**
 * @param {object} mood 当前六轴状态。
 * @param {object} [expression] 上一轮表达状态；缺省时也从 mood 读 sting。
 * @param {number} [now] Unix 秒。
 * @returns {boolean}
 */
export function unresolvedAnger(mood = {}, expression = mood, now = Date.now() / 1000) {
  const valence = Number(mood?.valence ?? 0);
  const arousal = Number(mood?.arousal ?? 0);
  const fromExpression = activeExpressionSignals(expression || {}, now).sting;
  const fromMood = activeExpressionSignals(mood || {}, now).sting;
  const sting = fromExpression || fromMood;
  const stingLevel = Math.max(0, Number(sting?.level || 0));
  const stingAfterSoothe = Boolean(sting) && Number(sting?.at || 0) > Number(mood?.pad?.soothed_at || 0);
  const hotExtreme = Array.isArray(mood?.extreme?.items)
    && mood.extreme.items.some((item) => item && HOT_LABEL.test(String(item.label || '')));
  const labels = mood?.pad?.labels && typeof mood.pad.labels === 'object'
    ? mood.pad.labels
    : {};
  const hotLabel = Object.entries(labels)
    .some(([word, score]) => HOT_LABEL.test(String(word || '')) && Number(score) >= 0.24);

  const angry = (
    (valence <= -40 && arousal >= 55)
    || (Boolean(sting) && stingLevel >= 3 && valence <= -28)
    || (Boolean(sting) && stingLevel >= 2 && valence <= -30 && arousal >= 45)
    || (hotExtreme && valence <= -32)
    || (hotLabel && valence <= -35 && arousal >= 45)
  );
  if (angry && recentlySoothed(mood, now) && !stingAfterSoothe && valence > -52) return false;
  return angry;
}

/**
 * @param {string} type 事件类型。
 * @returns {boolean}
 */
export function reparativeEvent(type) {
  return String(type || '') === '修复';
}
