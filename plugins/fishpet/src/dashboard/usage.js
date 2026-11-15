/**
 * 看板观测用量的纯聚合。
 *
 * 只统计上游真正上报过的 token / 费用。没有上报的轮次保持“未采集”，不能拿
 * 估算值补成金额；聚合范围由调用方决定，和页面展示的最近 N 轮分开。
 *
 * @module dsh-fishpet-emotion/dashboard/usage
 */

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function maybeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 1) {
  const scale = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
}

function addObservedUsage(target, usage) {
  for (const key of [
    'calls',
    'inputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'billedInputTokens',
    'outputTokens',
    'totalTokens',
    'reasoningTokens',
    'cost',
  ]) {
    const number = maybeNumber(usage?.[key]);
    if (number !== null) target[key] += number;
  }
  if (!target.currency && usage?.currency) target.currency = String(usage.currency).slice(0, 8);
}

function emptyObserved() {
  return {
    reportedRounds: 0,
    calls: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    billedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    currency: '',
  };
}

function finishObserved(value) {
  return {
    ...value,
    cost: round(value.cost, 6),
    cacheHitRate: value.billedInputTokens > 0
      ? round((value.cacheReadTokens / value.billedInputTokens) * 100, 1)
      : null,
    complete: false,
  };
}

/**
 * 聚合一组轮次的真实上报用量。
 *
 * @param {object[]} rounds 轮次记录；只需要 `at` 与 `usage`。
 * @param {number} nowMs 当前毫秒时间，用于划出“今天”。
 * @returns {{total: object, today: object}}
 */
export function summarizeObservedUsage(rounds, nowMs = Date.now()) {
  const total = emptyObserved();
  const today = emptyObserved();
  const startOfToday = new Date(Number(nowMs));
  startOfToday.setHours(0, 0, 0, 0);
  const cutoff = startOfToday.getTime();
  for (const round of Array.isArray(rounds) ? rounds : []) {
    const usage = isObject(round?.usage) ? round.usage : {};
    const hasMeasured = [
      usage.inputTokens,
      usage.outputTokens,
      usage.totalTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
      usage.cost,
    ].some((value) => maybeNumber(value) !== null);
    if (!hasMeasured) continue;
    total.reportedRounds += 1;
    addObservedUsage(total, usage);
    if (Number(round.at) >= cutoff) {
      today.reportedRounds += 1;
      addObservedUsage(today, usage);
    }
  }
  return {
    ...finishObserved(total),
    today: finishObserved(today),
  };
}
