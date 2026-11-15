/**
 * 信任慢变量：还欠着的事往下拽，近五天有交代的事往上抬。
 *
 * @module dsh-fishpet-emotion/relationship/trust
 */

import { getBucket } from '../memory/episodes.js';

const DAY = 86400;

/**
 * @param {object} inputMood
 * @param {object} inputEpisodes
 * @param {string} scope
 * @param {number} now
 * @returns {{mood: object, target: number, bad: number, settled: number}}
 */
export function refreshTrust(inputMood, inputEpisodes, scope = '', now = Date.now() / 1000) {
  const mood = { ...(inputMood || {}) };
  let current = Number(mood.trust ?? 10);
  const last = Number(mood.trust_at || 0);
  if (last <= 0) {
    mood.trust_at = now;
  } else {
    const days = Math.max(0, (now - last) / DAY);
    if (days > 0) {
      current = Math.min(Math.max(40, current), current + 1.6 * days);
      mood.trust_at = now;
    }
  }

  const bucket = getBucket(inputEpisodes, scope);
  let bad = 0;
  for (const item of bucket.items) {
    if (item.solved || item.who === '我') continue;
    const touched = Number(item.last_mention || item.opened_at || 0);
    if (touched && now - touched > 3 * DAY) continue;
    bad += 1;
  }
  bad = Math.min(10, bad);

  let settled = 0;
  for (const item of bucket.items) {
    if (!item.solved || item.who === '我') continue;
    const how = String(item.closed_by || '');
    if (!how || ['faded', 'no-evidence', 'done-before-merge'].includes(how)) continue;
    if (now - Number(item.closed_at || 0) > 5 * DAY) continue;
    const opened = Number(item.opened_at || 0);
    const duration = opened > 0 ? now - opened : 0;
    if (duration < 3 * 3600 && !['错', '对不起', '抱歉'].some((word) => how.includes(word))) continue;
    settled += 1;
  }
  settled = Math.min(4, settled);

  let target;
  if (bad || settled) {
    target = Math.max(-60, Math.min(70, 10 - 6 * bad + 4 * settled));
    if (!bad) target = Math.max(current, target);
  } else {
    target = current;
  }
  mood.trust = round(current + (target - current) * 0.2, 2);
  return { mood, target, bad, settled };
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
