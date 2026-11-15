/**
 * 内感受：把体力、心情唤醒和一天时段翻成身体信号。
 *
 * @module dsh-fishpet-emotion/life/interoception
 */

import { chemReadout } from '../engine/state.js';

export const BODY_MARKER = '【身体感觉】';
const MEAL_HOURS = Object.freeze([8, 12, 18, 22]);
const HUNGER_SCALE = 8;
const HUNGER_TIRED = 0.72;
const HUNGER_HARSH = 0.92;

/**
 * @param {number} now Unix 秒。
 * @returns {number} 0..1
 */
export function hungerLevel(now) {
  const date = new Date(now * 1000);
  const hour = date.getHours() + date.getMinutes() / 60;
  let lastMeal = null;
  for (const meal of MEAL_HOURS) if (meal <= hour) lastMeal = meal;
  let hours;
  if (lastMeal === null) {
    lastMeal = 22;
    hours = ((hour + 24) - lastMeal) % 24;
  } else {
    hours = hour - lastMeal;
  }
  return Math.max(0, Math.min(1, hours / HUNGER_SCALE));
}

/**
 * @param {object} life
 * @param {object} mood
 * @param {number} now
 * @returns {string}
 */
export function renderInteroception(life, mood, now) {
  if (life?.sleeping) return '';
  const energy = Number(life?.energy ?? 100);
  const chem = chemReadout(mood || {});
  const hour = new Date(now * 1000).getHours();
  const lines = [];
  if (energy < 18) lines.push('手有点凉、眼皮发沉，说话要费点劲。');
  else if (energy < 40) lines.push('身上有点乏，肩膀发紧');
  if (chem.cortisol >= 72) lines.push('心口发紧、坐不太住，容易被他一句话点火。');
  else if (chem.cortisol >= 45) lines.push('心里有点乱，注意力老跑。');
  if (chem.dopamine >= 70) lines.push('身上轻快，话比平时多，也更容易笑。');
  else if (chem.dopamine <= 24) lines.push('提不起劲，什么都懒懒的。');
  if (chem.serotonin <= 34) lines.push('心里空落落的，那种说不上来的没底气。');
  if ([0, 1, 2, 3, 4].includes(hour)) lines.push('这个点脑子发木，反应比白天慢');
  const hunger = hungerLevel(now);
  if (hunger >= HUNGER_HARSH) lines.push('肚子很饿，饿得有点心慌，说话会不太耐烦');
  else if (hunger >= HUNGER_TIRED) lines.push('身上有点空，做事的劲头短了一截');
  if (!lines.length) return '';
  return BODY_MARKER + '\n' +
    lines.slice(0, 4).map((line) => line.replace(/[。；;，, ]+$/g, '')).join('；') +
    '\n这些是身体的感觉，语气和节奏跟着它走，别把感觉念成状态条；它比平时的说话习惯更优先，宁可这轮少贫一点。';
}
