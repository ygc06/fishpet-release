/**
 * 字面事实闸门：只认几乎不可能有第二种意思的取消和道歉。
 *
 * @module dsh-fishpet-emotion/engine/facts
 */

export const CANCEL_FACTS = Object.freeze([
  '不去了',
  '不来了',
  '去不了',
  '来不了',
  '放你鸽子',
  '鸽了',
  '改天吧',
  '改天再',
  '下次吧',
]);

export const APOLOGY_FACTS = Object.freeze([
  '对不起',
  '抱歉',
  '是我不对',
  '我错了',
  '是我不好',
  '我说重了',
]);

export const DENIED_FACTS = Object.freeze([
  '不是你的错',
  '别道歉',
  '你不用抱歉',
  '不是说不去',
  '别说对不起',
]);

export const EVIDENCED_EVENT_TYPES = Object.freeze(['挑刺', '失约', '拒绝', '冷落']);

/**
 * 扫描字面事实。
 *
 * @param {unknown} text 原话。
 * @returns {{type: '修复'|'失约', quote: string}|null}
 */
export function scanFacts(text) {
  const said = String(text ?? '');
  if (!said.trim()) return null;
  if (DENIED_FACTS.some((word) => said.includes(word))) return null;
  for (const word of APOLOGY_FACTS) {
    if (said.includes(word)) return { type: '修复', quote: word };
  }
  for (const word of CANCEL_FACTS) {
    if (said.includes(word)) return { type: '失约', quote: word };
  }
  return null;
}

/**
 * 把模型判读和字面规则合成最终事件。
 *
 * @param {unknown} etype 模型事件类型。
 * @param {unknown} quote 模型摘句。
 * @param {unknown} text 原话。
 * @returns {{type: string, quote: string, evidenced: boolean}}
 */
export function decideEvent(etype, quote, text) {
  let type = String(etype || '普通');
  let evidence = String(quote ?? '').slice(0, 120);
  const said = String(text ?? '');
  const rule = scanFacts(said);

  if (rule && (type === '普通' || type === '' || type === '拒绝')) {
    type = rule.type;
    evidence = rule.quote;
  }
  if (EVIDENCED_EVENT_TYPES.includes(type) && (!evidence || !said.includes(evidence))) {
    evidence = said.slice(0, 120);
  }
  return {
    type,
    quote: evidence,
    evidenced: Boolean(evidence) && said.includes(evidence),
  };
}

/**
 * 生成“他道过歉，但没听出是哪件事”的短期提示。
 * 只递一次；默认六小时后自然失效。
 *
 * @param {unknown} hint 道歉提示。
 * @param {number} [now] Unix 秒。
 * @param {number} [ttl] 有效秒数。
 * @returns {string}
 */
export function repairHintLine(hint, now = Date.now() / 1000, ttl = 6 * 3600) {
  if (!hint || typeof hint !== 'object' || Array.isArray(hint)) return '';
  const at = Number(hint.at || 0);
  const current = Number(now);
  if (!Number.isFinite(at) || at <= 0 || !Number.isFinite(current)) return '';
  if (current - at > Number(ttl)) return '';
  if (Number(hint.asked_at || 0) > 0) return '';
  const said = String(hint.text ?? '').slice(0, 24);
  if (!said) return '';
  return `他道过歉（他说的是「${said}」），我没听出是为哪件事——想问，还没问`;
}
