/**
 * 存储 schema 版本 1 的默认结构与写前校验。
 *
 * 只做结构校验：类型、必填字段、枚举级别的边界；不写业务文案、不做情绪数值换算。
 * 校验失败只回传字段名（`reasons`），绝不回显字段值，避免正文进入日志或错误串。
 *
 * @module dsh-fishpet-emotion/store/schema-v1
 */

import { DELTA_KEYS } from '../domain/enums.js';
import { checkEventId } from '../domain/event-id.js';

/** 当前唯一受支持的 schema 版本。 */
export const SCHEMA_VERSION = 1;

/** 存储目录里的固定文件名（`backups` 是目录）。 */
export const FILES = Object.freeze({
  meta: 'meta.json',
  state: 'state.json',
  layer2: 'layer2-state.json',
  usage: 'usage.json',
  events: 'events.jsonl',
  backups: 'backups',
});

/** 允许出现在存储目录里的文件（不含 backups 目录）。 */
export const DATA_FILES = Object.freeze([FILES.meta, FILES.state, FILES.layer2, FILES.usage, FILES.events]);

/** feelings 上限（与契约 §7 一致）。 */
const FEELINGS_MAX_ITEMS = 3;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 默认状态：四轴归零、心绪池为空。
 *
 * @param {number} [now] 毫秒时间戳
 * @returns {import('../domain/types.js').StoredState}
 */
export function createDefaultState(now = Date.now()) {
  /** @type {Record<string, number>} */
  const axes = {};
  for (const key of DELTA_KEYS) axes[key] = 0;
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: isFiniteNumber(now) ? now : 0,
    axes,
    feelings: [],
    emo: '',
    mood: '',
    state: '',
    lastEventId: '',
  };
}

/**
 * 默认用量计数。
 *
 * @returns {import('../domain/types.js').StoredUsage}
 */
export function createDefaultUsage() {
  return {
    schemaVersion: SCHEMA_VERSION,
    judged: 0,
    failed: 0,
    degraded: 0,
    lastJudgeAt: 0,
  };
}

/**
 * 默认元信息。
 *
 * @param {number} [now] 毫秒时间戳
 * @returns {{schemaVersion: number, createdAt: number, updatedAt: number}}
 */
export function createDefaultMeta(now = Date.now()) {
  const stamp = isFiniteNumber(now) ? now : 0;
  return { schemaVersion: SCHEMA_VERSION, createdAt: stamp, updatedAt: stamp };
}

/**
 * 判断读到的对象是否声明了一个「不是 1」的 schemaVersion。
 * 缺字段不算 mismatch（那是结构损坏）；显式写了别的版本才算。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isUnknownSchemaVersion(value) {
  return isPlainObject(value) && 'schemaVersion' in value && value.schemaVersion !== SCHEMA_VERSION;
}

/**
 * 写前校验 StoredState。
 *
 * @param {unknown} value
 * @returns {{ok: true} | {ok: false, code: 'invalid-state', reasons: string[]}}
 */
export function validateState(value) {
  /** @type {string[]} */
  const reasons = [];
  if (!isPlainObject(value)) {
    return { ok: false, code: 'invalid-state', reasons: ['root'] };
  }
  if (value.schemaVersion !== SCHEMA_VERSION) reasons.push('schemaVersion');
  if (!isFiniteNumber(value.updatedAt) || value.updatedAt < 0) reasons.push('updatedAt');

  if (!isPlainObject(value.axes)) {
    reasons.push('axes');
  } else {
    for (const key of DELTA_KEYS) {
      if (!isFiniteNumber(value.axes[key])) reasons.push('axes.' + key);
    }
  }

  if (!Array.isArray(value.feelings)) {
    reasons.push('feelings');
  } else {
    if (value.feelings.length > FEELINGS_MAX_ITEMS) reasons.push('feelings.length');
    value.feelings.forEach((item, index) => {
      if (typeof item !== 'string') reasons.push('feelings.' + index);
    });
  }

  for (const key of ['emo', 'mood', 'state', 'lastEventId']) {
    if (typeof value[key] !== 'string') reasons.push(key);
  }

  return reasons.length ? { ok: false, code: 'invalid-state', reasons } : { ok: true };
}

/**
 * 校验 usage.json。
 *
 * @param {unknown} value
 * @returns {{ok: true} | {ok: false, reasons: string[]}}
 */
export function validateUsage(value) {
  /** @type {string[]} */
  const reasons = [];
  if (!isPlainObject(value)) return { ok: false, reasons: ['root'] };
  if (value.schemaVersion !== SCHEMA_VERSION) reasons.push('schemaVersion');
  for (const key of ['judged', 'failed', 'degraded']) {
    if (!isFiniteNumber(value[key]) || value[key] < 0) reasons.push(key);
  }
  if (!isFiniteNumber(value.lastJudgeAt) || value.lastJudgeAt < 0) reasons.push('lastJudgeAt');
  return reasons.length ? { ok: false, reasons } : { ok: true };
}

/**
 * 校验 meta.json。
 *
 * @param {unknown} value
 * @returns {{ok: true} | {ok: false, reasons: string[]}}
 */
export function validateMeta(value) {
  /** @type {string[]} */
  const reasons = [];
  if (!isPlainObject(value)) return { ok: false, reasons: ['root'] };
  if (value.schemaVersion !== SCHEMA_VERSION) reasons.push('schemaVersion');
  for (const key of ['createdAt', 'updatedAt']) {
    if (!isFiniteNumber(value[key]) || value[key] < 0) reasons.push(key);
  }
  return reasons.length ? { ok: false, reasons } : { ok: true };
}

/**
 * 校验 events.jsonl 单行记录（LedgerRecord）。
 *
 * @param {unknown} value
 * @returns {{ok: true} | {ok: false, reasons: string[]}}
 */
export function validateLedgerRecord(value) {
  /** @type {string[]} */
  const reasons = [];
  if (!isPlainObject(value)) return { ok: false, reasons: ['root'] };
  if (value.schemaVersion !== SCHEMA_VERSION) reasons.push('schemaVersion');
  // 与信封、commit、索引、意图恢复共用同一份合同（R2 派工单 P0-2）：
  // 只在这里放一条 200 长度线是不够的，换行/控制字符/孤立 surrogate 同样会破坏索引。
  const checkedId = checkEventId(value.eventId);
  // 账本里只能保存规范形。`checkEventId()` 会 trim；若这里接受带首尾空白的原值，
  // 账本与索引会分别记住两个不同字符串，后续重放就可能无法按同一身份查重。
  if (!checkedId.ok || checkedId.id !== value.eventId) reasons.push('eventId');
  if (!isFiniteNumber(value.at) || value.at < 0) reasons.push('at');
  if (typeof value.channel !== 'string' || !value.channel) reasons.push('channel');
  if (typeof value.act !== 'string') reasons.push('act');
  if (typeof value.emo !== 'string') reasons.push('emo');
  if (!Array.isArray(value.delta) || value.delta.length !== DELTA_KEYS.length) {
    reasons.push('delta');
  } else {
    value.delta.forEach((item, index) => {
      if (!isFiniteNumber(item)) reasons.push('delta.' + index);
    });
  }
  if (typeof value.hash !== 'string') reasons.push('hash');
  return reasons.length ? { ok: false, reasons } : { ok: true };
}

/**
 * 深拷贝可 JSON 化状态，避免调用方改到缓存。
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
