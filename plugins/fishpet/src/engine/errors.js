/**
 * 识别框架/模型错误文本，避免把报错当成角色回复。
 *
 * @module dsh-fishpet-emotion/engine/errors
 */

export const LLM_ERROR_MARKERS = Object.freeze([
  'LLM 响应错误',
  'All chat models failed',
  'Error code:',
  'InternalServerError',
  'Traceback (most recent call last)',
  'APIConnectionError',
  'APIError',
  'insufficient_quota',
  'Connection error',
  'Bad Gateway',
  'Service Unavailable',
  'Gateway Timeout',
]);

/**
 * @param {unknown} text 待检查文本。
 * @returns {boolean}
 */
export function looksLikeLlmError(text) {
  const said = String(text ?? '').trim();
  if (!said) return false;
  const head = said.slice(0, 400);
  return LLM_ERROR_MARKERS.some((marker) => head.includes(marker));
}
