/**
 * 量程与爆发通道。
 *
 * @module dsh-fishpet-emotion/engine/saturation
 */

export const BURST_MIN = 25;

export const AXIS_SPEC = Object.freeze({
  dopamine: Object.freeze([0, 100, 50]),
  cortisol: Object.freeze([0, 100, 20]),
  serotonin: Object.freeze([0, 100, 50]),
  valence: Object.freeze([-120, 120, 0]),
  energy: Object.freeze([0, 100, 65]),
  vitality: Object.freeze([0, 100, 65]),
  arousal: Object.freeze([-100, 100, 0]),
  clingy: Object.freeze([-20, 60, 0]),
  dominance: Object.freeze([-100, 100, 0]),
});

/**
 * @param {unknown} key
 * @returns {string}
 */
export function normalizeAxisKey(key) {
  const value = String(key || '');
  if (value === 'mood' || value === 'spirit') return 'valence';
  if (value === 'cling') return 'clingy';
  return value;
}

/**
 * 从模型结果里摘出一次爆发。支持旧 `{key,delta,why}` 与契约的按轴对象。
 *
 * @param {object} mind
 * @returns {{delta: Record<string, number>, burst: {key: string, delta: number, why: string}|null}}
 */
export function splitBurst(mind) {
  const source = mind && typeof mind === 'object' ? mind : {};
  const delta = { ...(source.delta && typeof source.delta === 'object' ? source.delta : {}) };
  const raw = source.burst;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { delta, burst: null };

  let key = normalizeAxisKey(raw.key);
  let value = Number(raw.delta || 0);
  if (!raw.key) {
    const candidates = Object.entries(raw)
      .filter(([axis]) => AXIS_SPEC[normalizeAxisKey(axis)])
      .map(([axis, amount]) => [normalizeAxisKey(axis), Number(amount)])
      .filter(([, amount]) => Number.isFinite(amount));
    candidates.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    if (!candidates.length) return { delta, burst: null };
    [key, value] = candidates[0];
  }
  if (!AXIS_SPEC[key] || !Number.isFinite(value) || Math.abs(value) < BURST_MIN) {
    return { delta, burst: null };
  }
  delete delta[key];
  return {
    delta,
    burst: {
      key,
      delta: value,
      why: String(raw.why || '').slice(0, 80),
    },
  };
}

/**
 * @param {unknown} key
 * @param {unknown} value
 * @returns {number}
 */
export function clampAxis(key, value) {
  const normalized = normalizeAxisKey(key);
  const bounds = AXIS_SPEC[normalized] || [-1e9, 1e9, 0];
  return Math.max(bounds[0], Math.min(bounds[1], Number(value)));
}

/**
 * @param {object} mood
 * @param {string} [key]
 * @returns {boolean}
 */
export function inBurst(mood, key) {
  const items = mood?.extreme?.items;
  if (!Array.isArray(items) || !items.length) return false;
  if (key === undefined) return true;
  const normalized = normalizeAxisKey(key);
  return items.some((item) => normalizeAxisKey(item?.key) === normalized);
}
