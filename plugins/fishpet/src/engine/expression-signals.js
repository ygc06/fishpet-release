/**
 * 情绪表达信号的统一时效。
 *
 * 小模型只在信号真的发生时输出 mask / surge / sting。信号写入状态后，
 * 观察快照和陪伴上下文都必须按同一套时间窗口读取，不能一边按“仅本轮”
 * 丢掉刚发生不久的信息，另一边又让过期旧信号无限回流。
 *
 * @module dsh-fishpet-emotion/engine/expression-signals
 */

export const EXPRESSION_SIGNAL_TTL_SECONDS = Object.freeze({
  mask: 40 * 60,
  surge: 30 * 60,
  sting: 2 * 60 * 60,
});

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unixSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return Date.now() / 1000;
  return number > 10_000_000_000 ? number / 1000 : number;
}

function activeSignal(expression, key, now) {
  const signal = expression && expression[key];
  if (!isObject(signal)) return null;
  const at = Number(signal.at ?? expression.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  const age = now - at;
  if (age < 0 || age >= EXPRESSION_SIGNAL_TTL_SECONDS[key]) return null;
  return { ...signal, at };
}

/**
 * 返回当前仍有效的表达信号，并保留原始 level / kind / q。
 *
 * @param {object} expression 第二层状态里的 emotion。
 * @param {number} [now] Unix 秒。
 * @returns {{mask: object|null, surge: object|null, sting: object|null}}
 */
export function activeExpressionSignals(expression, now = Date.now() / 1000) {
  const stamp = unixSeconds(now);
  return {
    mask: activeSignal(expression, 'mask', stamp),
    surge: activeSignal(expression, 'surge', stamp),
    sting: activeSignal(expression, 'sting', stamp),
  };
}
