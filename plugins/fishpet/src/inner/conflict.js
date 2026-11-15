/**
 * 内在冲突：困、想聊、还气着、答应的事互相拉扯时，选一个站稳。
 *
 * 随机选择必须由调用方注入；默认固定选 A，生产层可传种子随机源。
 *
 * @module dsh-fishpet-emotion/inner/conflict
 */

import { chemReadout } from '../engine/state.js';

export const CONFLICT_MARKER = '【正在纠结】';
export const STANCE_KEEP = 12 * 60;

/**
 * @returns {{version: number, stance: string|null, stance_at: number}}
 */
export function createConflictState() {
  return { version: 1, stance: null, stance_at: 0 };
}

/**
 * @param {object} life
 * @param {object} mood
 * @param {boolean} hasPromiseDue
 * @returns {{sleep: number, chat: number, sulk: number, promise: number}}
 */
export function drives(life, mood, hasPromiseDue = false) {
  const energy = Number(life?.energy ?? 100);
  const chem = chemReadout(mood);
  const valence = Number(mood?.valence ?? 0);
  const clingy = Number(mood?.clinginess ?? 15);
  const sleep = clamp01((45 - energy) / 45);
  let chat = clamp01(clingy / 100 + (valence / 100) * 0.6 + (chem.dopamine - 50) / 250);
  if (energy < 8) chat *= 0.35;
  const angry = clamp01((chem.cortisol - 45) / 55);
  const sulk = clamp01(angry * 0.8 + (40 - chem.serotonin) / 120);
  return {
    sleep: round(sleep, 2),
    chat: round(chat, 2),
    sulk: round(sulk, 2),
    promise: hasPromiseDue ? 1 : 0,
  };
}

/**
 * @param {object} life
 * @param {object} driveValues
 * @returns {object[]}
 */
export function conflictCandidates(life, driveValues) {
  const out = [];
  if (driveValues.sleep >= 0.45 && driveValues.chat >= 0.45) {
    out.push({
      kind: 'sleep_vs_chat',
      weight: driveValues.sleep * 0.6 + driveValues.chat * 0.4,
      want: '困得不行，但又不想让你觉得她在敷衍',
      A: '嘴上说「困了」，还硬撑着多聊两句',
      B: '直接说要睡，约好明天再说',
    });
  }
  if (driveValues.sulk >= 0.5) {
    out.push({
      kind: 'sulk_vs_cling',
      weight: driveValues.sulk,
      want: '火还没消，普通一句好话不能翻篇',
      A: '直接把火发出来，点明他哪句踩线',
      B: '冷着脸把界线说清，不装委屈也不求哄',
    });
  }
  if (driveValues.promise >= 0.5 && driveValues.sleep >= 0.3) {
    out.push({
      kind: 'promise_vs_tired',
      weight: driveValues.promise * 0.7 + driveValues.sleep * 0.3,
      want: '答应过的事还没兑现，可人已经很累了',
      A: '先提出来，说明天补',
      B: '憋着不说，怕又要被翻旧账',
    });
  }
  return out;
}

/**
 * @param {object} input
 * @param {object} life
 * @param {object} mood
 * @param {boolean} hasPromiseDue
 * @param {number} now
 * @param {() => number} random
 * @returns {object|null}
 */
export function chooseConflict(input, life, mood, hasPromiseDue, now, random = () => 0) {
  const state = normalizeState(input);
  const driveValues = drives(life, mood, hasPromiseDue);
  const candidates = conflictCandidates(life, driveValues);
  if (!candidates.length) {
    state.stance = null;
    return null;
  }
  candidates.sort((a, b) => b.weight - a.weight);
  let top = candidates[0];
  let choice;
  if (state.stance && now - Number(state.stance_at || 0) < STANCE_KEEP && candidates.some((item) => item.kind === state.stance)) {
    top = candidates.find((item) => item.kind === state.stance);
    choice = state.choice || (Number(random()) < 0.5 ? 'A' : 'B');
  } else {
    choice = Number(random()) < 0.5 + (top.weight - 0.5) * 0.4 ? 'A' : 'B';
    state.stance = top.kind;
    state.choice = choice;
    state.stance_at = Number(now);
  }
  return {
    kind: top.kind,
    want: top.want,
    choice,
    text: top[choice],
    drives: driveValues,
  };
}

/**
 * @param {object} input
 * @param {object} life
 * @param {object} mood
 * @param {boolean} hasPromiseDue
 * @param {number} now
 * @param {() => number} random
 * @returns {string}
 */
export function renderConflict(input, life, mood, hasPromiseDue, now, random = () => 0) {
  const picked = chooseConflict(input, life, mood, hasPromiseDue, now, random);
  if (!picked) return '';
  return `${CONFLICT_MARKER}\n你心里在打架：${picked.want}。\n这次你选了：${picked.text}——这一轮就按这个口风走，别一句话一个态度；这比平时的说话习惯更优先。\n（只是内部的倾向，不要把它说出来，也不要说自己在纠结。）`;
}

function normalizeState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return createConflictState();
  return input;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value)));
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
