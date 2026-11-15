/**
 * 第 2 层扩展状态的默认结构与写前校验。
 *
 * 第 1 层 `state.json` 保持 schema v1 不变；六轴、关系账本和身体状态写入独立的
 * `layer2-state.json`（schema v2）。这样老版本仍能读取四轴快照，新版本也不会
 * 偷偷把 v1 文件改写成另一种结构。
 *
 * @module dsh-fishpet-emotion/store/schema-v2
 */

import { createAffinityState, createMoodState } from '../engine/state.js';
import { createPromiseState } from '../memory/promises.js';
import { createEpisodeState } from '../memory/episodes.js';
import { createCoreMemoryState } from '../memory/core-memory.js';
import { createSkillState } from '../memory/skills.js';
import { createInnerLifeState } from '../inner/inner-life.js';
import { createConflictState } from '../inner/conflict.js';
import { createVitalityState } from '../life/vitality.js';
import { createBackgroundState } from '../life/background.js';
import { checkEventId } from '../domain/event-id.js';

export const LAYER2_SCHEMA_VERSION = 2;
export const LAYER2_FILE = 'layer2-state.json';

const ROOT_KEYS = new Set([
  'schemaVersion',
  'revision',
  'updatedAt',
  'lastEventId',
  'channel',
  'scope',
  'actorName',
  'mood',
  'emotion',
  'affinity',
  'episodes',
  'promises',
  'coreMemory',
  'skills',
  'inner',
  'vitality',
  'background',
  'conflict',
  'judgement',
  'judgementLast',
  'repairHint',
  'expression',
  'context',
  'lastEvent',
  'lastAction',
  'lastCrisisAt',
]);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function string(value, max = 2000) {
  return typeof value === 'string' && value.length <= max;
}

function array(value) {
  return Array.isArray(value);
}

function objectArray(value) {
  return Array.isArray(value) && value.every(isObject);
}

function nullObject(value) {
  return value === null || isObject(value);
}

function validExtreme(value) {
  if (!isObject(value)) return false;
  return array(value.items) && array(value.keys) && array(value.new_items)
    && string(value.label, 80) && string(value.new_label, 80) && finite(value.at);
}

function validMood(value) {
  if (!isObject(value)) return false;
  for (const key of [
    'valence', 'energy', 'arousal', 'valence_base', 'cling_adj', 'dominance',
    'trust', 'trust_at', 'updated_at', 'last_user_msg_at', 'last_impulse',
    'episode_tail', 'regress', 'neg_streak', 'reg_cool',
  ]) {
    if (!finite(value[key])) return false;
  }
  return string(value.last_emo, 40)
    && nullObject(value.surge)
    && string(value.day, 32)
    && finite(value.day_msgs)
    && validExtreme(value.extreme);
}

function validExpression(value) {
  if (!isObject(value)) return false;
  if (!array(value.feelings) || !value.feelings.every((item) => string(item, 40))) return false;
  if (!objectArray(value.feelLinks || [])) return false;
  for (const key of ['emo', 'mood', 'state', 'read', 'why', 'body', 'carry', 'letGo']) {
    if (!string(value[key], key === 'state' ? 1200 : 160)) return false;
  }
  return finite(value.at)
    && nullObject(value.surge)
    && nullObject(value.sting)
    && nullObject(value.mask)
    && nullObject(value.hit);
}

function validAffinity(value) {
  if (!isObject(value) || !isObject(value.users)) return false;
  for (const record of Object.values(value.users)) {
    if (!isObject(record)) return false;
    if (!finite(record.score) || !finite(record.last_seen)) return false;
    if (!string(record.name || '', 60)) return false;
  }
  return true;
}

function validEpisodes(value) {
  if (!isObject(value) || !isObject(value.scopes) || !objectArray(value.memory)) return false;
  for (const bucket of Object.values(value.scopes)) {
    if (!isObject(bucket) || !objectArray(bucket.items) || !isObject(bucket.last)) return false;
  }
  return true;
}

function validPromises(value) {
  return isObject(value) && finite(value.next_id) && objectArray(value.promises);
}

function validCoreMemory(value) {
  return isObject(value) && finite(value.next_id) && objectArray(value.entries);
}

function validSkills(value) {
  return isObject(value) && finite(value.next_id) && objectArray(value.rules);
}

function validInner(value) {
  return isObject(value)
    && finite(value.next_id)
    && objectArray(value.gaps)
    && objectArray(value.scars);
}

function validVitality(value) {
  return isObject(value)
    && finite(value.energy)
    && value.energy >= 0
    && value.energy <= 100
    && typeof value.sleeping === 'boolean'
    && finite(value.turns)
    && objectArray(value.epiphanies)
    && objectArray(value.closed_loops);
}

function validBackground(value) {
  return isObject(value)
    && finite(value.passes_today)
    && isObject(value.backdrop)
    && isObject(value.ferment)
    && array(value.queue)
    && array(value.log_tail);
}

function validConflict(value) {
  return isObject(value)
    && (value.stance === null || string(value.stance, 40))
    && finite(value.stance_at);
}

function validJudgement(value) {
  return value === null || (
    isObject(value)
    && string(value.text || '', 80)
    && finite(value.at || 0)
    && finite(value.trust || 0)
    && finite(value.clingy || 0)
  );
}

function validEvent(value) {
  return value === null || (
    isObject(value)
    && string(value.type || '', 12)
    && string(value.quote || '', 120)
    && string(value.what || '', 160)
    && string(value.label || '', 24)
    && string(value.who || '', 4)
    && finite(value.weight || 0)
    && typeof (value.unsolved ?? false) === 'boolean'
  );
}

function validAction(value) {
  return value === null || (
    isObject(value)
    && string(value.act || '', 16)
    && string(value.model || '', 16)
    && string(value.type || '', 12)
    && typeof value.downgraded === 'boolean'
    && finite(value.at || 0)
  );
}

/**
 * 新建第 2 层默认状态。时间单位为 Unix 秒，与旧 Python 状态一致。
 *
 * @param {number} [now] Unix 秒。
 * @returns {object}
 */
export function createDefaultLayer2State(now = Date.now() / 1000) {
  const stamp = Number.isFinite(Number(now)) ? Number(now) : 0;
  const mood = createMoodState(stamp);
  // 旧 mood.json 里已有这层短时 PAD。它不是第七/第八根情绪轴：
  // 只让模型自由给出的词在随后几轮里保留一点余味，并按固定半衰期淡掉。
  mood.pad = {
    p: 0.05,
    a: 0.35,
    d: 0.5,
    labels: {},
    trigger: '',
    at: 0,
  };
  mood.extreme = {
    items: [],
    keys: [],
    new_items: [],
    label: '',
    new_label: '',
    at: 0,
    entered_at: {},
  };
  return {
    schemaVersion: LAYER2_SCHEMA_VERSION,
    // 单文件状态的可选比较版本。旧 v2 文件没有这个字段时仍可读，
    // 下一次联合提交会自动从 0 开始推进，避免只用秒级时间戳做 CAS。
    revision: 0,
    updatedAt: stamp,
    lastEventId: '',
    channel: '',
    scope: '',
    actorName: '',
    mood,
    emotion: {
      feelings: [],
      feelLinks: [],
      emo: '',
      mood: '',
      state: '',
      read: '',
      why: '',
      body: '',
      carry: '',
      anchor: null,
      letGo: '',
      at: 0,
      surge: null,
      sting: null,
      mask: null,
      hit: null,
    },
    affinity: createAffinityState(),
    episodes: createEpisodeState(),
    promises: createPromiseState(),
    coreMemory: createCoreMemoryState(),
    skills: createSkillState(),
    inner: createInnerLifeState(),
    vitality: createVitalityState(),
    background: createBackgroundState(),
    conflict: createConflictState(),
    judgement: null,
    judgementLast: null,
    repairHint: null,
    context: { recent: [], dialog: [], lastInjectionAt: 0 },
    lastEvent: null,
    lastAction: null,
    lastCrisisAt: 0,
  };
}

/**
 * 严格校验写前对象；失败只返回字段名，不回显正文。
 *
 * @param {unknown} value
 * @returns {{ok: true} | {ok: false, code: string, reasons: string[]}}
 */
export function validateLayer2State(value) {
  const reasons = [];
  if (!isObject(value)) return { ok: false, code: 'invalid-layer2-state', reasons: ['root'] };
  for (const key of Object.keys(value)) {
    if (!ROOT_KEYS.has(key)) reasons.push('unknown.' + key.slice(0, 40));
  }
  if (value.schemaVersion !== LAYER2_SCHEMA_VERSION) reasons.push('schemaVersion');
  if (value.revision !== undefined
    && (!Number.isInteger(value.revision) || value.revision < 0)) {
    reasons.push('revision');
  }
  if (!finite(value.updatedAt) || value.updatedAt < 0) reasons.push('updatedAt');
  if (!string(value.lastEventId, 200)) reasons.push('lastEventId');
  else if (value.lastEventId) {
    const checked = checkEventId(value.lastEventId);
    if (!checked.ok || checked.id !== value.lastEventId) reasons.push('lastEventId');
  }
  for (const key of ['channel', 'scope', 'actorName']) {
    if (!string(value[key], key === 'actorName' ? 60 : 240)) reasons.push(key);
  }
  if (!validMood(value.mood)) reasons.push('mood');
  if (!validExpression(value.emotion)) reasons.push('emotion');
  if (!validAffinity(value.affinity)) reasons.push('affinity');
  if (!validEpisodes(value.episodes)) reasons.push('episodes');
  if (!validPromises(value.promises)) reasons.push('promises');
  if (!validCoreMemory(value.coreMemory)) reasons.push('coreMemory');
  if (!validSkills(value.skills)) reasons.push('skills');
  if (!validInner(value.inner)) reasons.push('inner');
  if (!validVitality(value.vitality)) reasons.push('vitality');
  if (!validBackground(value.background)) reasons.push('background');
  if (!validConflict(value.conflict)) reasons.push('conflict');
  if (!validJudgement(value.judgement)) reasons.push('judgement');
  if (!validJudgement(value.judgementLast)) reasons.push('judgementLast');
  if (!validJudgement(value.repairHint)) reasons.push('repairHint');
  if (!isObject(value.context)
    || !objectArray(value.context.recent)
    || !objectArray(value.context.dialog)
    || !finite(value.context.lastInjectionAt)) {
    reasons.push('context');
  }
  if (!validEvent(value.lastEvent)) reasons.push('lastEvent');
  if (!validAction(value.lastAction)) reasons.push('lastAction');
  if (!finite(value.lastCrisisAt) || value.lastCrisisAt < 0) reasons.push('lastCrisisAt');
  return reasons.length
    ? { ok: false, code: 'invalid-layer2-state', reasons }
    : { ok: true };
}
