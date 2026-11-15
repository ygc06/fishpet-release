/**
 * Conservative local visual-intent gate.
 *
 * This is not a model classifier and costs nothing. It only creates a
 * one-shot opportunity for the current companion message; the Agent still
 * decides whether the image is genuinely needed.
 *
 * @module dsh-fishpet-emotion/host/screen-intent
 */

const VISUAL_INTENT_PATTERNS = Object.freeze([
  /看看|看一下|看一眼|看下|瞅瞅|瞅一眼|瞧瞧/,
  /屏幕|桌面|画面|界面|弹窗|弹框|提示框|报错|错误提示/,
  /这(?:张|个|幅)图|图里|截图|图片内容/,
]);

export function hasExplicitVisualIntent(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return false;
  return VISUAL_INTENT_PATTERNS.some((pattern) => pattern.test(value));
}
