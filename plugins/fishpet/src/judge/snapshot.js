/**
 * 给小模型观察员的只读状态快照。
 *
 * 这里只发由程序和六轴派生的事实，不发上一轮模型写过的 mood/state/read。
 * 观察员需要知道她此刻处于什么状态、还挂着哪件事；不需要再读一段别人替她
 * 写好的内心戏。
 *
 * @module dsh-fishpet-emotion/judge/snapshot
 */

import { layer2View } from '../engine/apply.js';
import { describeFeelings } from '../engine/feel-language.js';
import { pullOpenItems } from '../life/background.js';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unixSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return Date.now() / 1000;
  return number > 10_000_000_000 ? number / 1000 : number;
}

function pendingItems(layer2, scope) {
  const bucket = layer2?.episodes?.scopes?.[scope];
  return pullOpenItems({
    scopes: {
      [scope]: isObject(bucket) ? bucket : { items: [] },
    },
  }, 9).map((item, index) => {
    const type = String(item.type || '旧事').trim().slice(0, 12);
    const label = String(item.label || '').trim().slice(0, 12);
    const quote = String(item.quote || '').trim().slice(0, 60);
    const mentions = Number(item.mentions || 1);
    const suffix = mentions > 1 ? `，前后提过${mentions}次` : '';
    return `${index + 1}. ${type}${label ? `（${label}）` : ''}：「${quote}」${suffix}`;
  });
}

/**
 * 构造 `JudgeEnvelopeV1.stateSnapshot`。
 *
 * @param {object} layer2 当前第 2 层状态。
 * @param {object} [options]
 * @param {number} [options.now] 毫秒或秒时间戳。
 * @param {string} [options.scope] 当前关系作用域。
 * @returns {object|null}
 */
export function buildJudgeStateSnapshot(layer2, options = {}) {
  if (!isObject(layer2)) return null;
  const now = unixSeconds(options.now);
  const scope = String(options.scope || layer2.scope || 'default');
  const view = layer2View(layer2, now * 1000);
  const expression = isObject(layer2.emotion) ? layer2.emotion : {};
  const feelingMood = {
    ...(isObject(layer2.mood) ? layer2.mood : {}),
    valence: view.valence,
    arousal: view.arousal,
    dominance: view.dominance,
    clingy: view.clinginess,
    trust: view.trust,
    mask: expression.mask || null,
    surge: expression.surge || null,
    sting: expression.sting || null,
  };
  const felt = describeFeelings(
    feelingMood,
    layer2.vitality,
    '',
    undefined,
    2,
    now
  ).replace(/^【她此刻】/, '').replace(/。$/u, '');
  const extreme = String(layer2.mood?.extreme?.label || '').trim();
  const stateText = [
    felt,
    extreme ? `她现在正处在「${extreme}」里` : '',
  ].filter(Boolean).join('；');
  const pending = pendingItems(layer2, scope);
  const judgement = String(layer2.judgement?.text || '').trim().slice(0, 80);
  const feelings = Array.isArray(expression.feelings)
    ? expression.feelings
      .map((word) => String(word || '').trim())
      .filter(Boolean)
      .slice(0, 4)
    : [];

  return {
    stateText,
    feelings,
    pending,
    relationship: judgement,
    updatedAt: Number(layer2.updatedAt || 0),
  };
}
