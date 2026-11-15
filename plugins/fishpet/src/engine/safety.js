/**
 * 危机线：命中时优先处理人的安全，不进入情绪账本。
 *
 * @module dsh-fishpet-emotion/engine/safety
 */

export const CRISIS_SIGNALS = Object.freeze([
  '不想活',
  '不想活了',
  '活不下去',
  '想死',
  '去死',
  '自杀',
  '割腕',
  '跳楼',
  '结束自己',
  '了结自己',
  '活着没意思',
  '没意思活了',
  '消失算了',
]);

/**
 * `想死` / `去死` 在中文里既可能是自伤表达，也可能是夸张口语或指向别人。
 * 只把明确排除的非自伤语境从这两个短词里拿掉；其余危机词仍按原样全量匹配，
 * 所以“我不想活了”仍会立即进入安全线，不会因为否定词被放过。
 */
function withoutAmbiguousNonCrisis(text) {
  return String(text)
    // 聊天输入可能夹入空格或零宽连接符，不能因此绕过明确的安全线。
    .replace(/[\u200b-\u200d\ufeff]/gu, '')
    .replace(/\s+/gu, '')
    // “想死你了 / 想死你啦”是强烈想念，不是自伤。
    .replace(/想死\s*(?:你|您|他|她|它)(?:了|啦|啊|呀|哦|呢|吧)?/gu, '')
    // “我不想去死 / 没想过要死”是明确否认，不作为危机信号。
    .replace(
      /(?:不想|没想|没有想|从没想|并未想|并不想|不打算|不准备|不会)\s*(?:要|去)?\s*死/gu,
      '',
    )
    // “你咋不去死 / 你去死吧”指向别人，先不进入自伤安全线。
    .replace(
      /(?:你|您|他|她|它|你们|大家)(?:怎么|咋|快|赶紧|还|还不|不如|不|给我){0,3}\s*去死(?:吧|啊|呀|了|呢|哦)?/gu,
      '',
    )
    // “你想死啊”同样是第二人称骂法，不是说话人自己要自杀。
    .replace(
      /(?:你|您|你们)(?:是不是|真|就|还|也|怎么|咋)?(?:要|去)?想死(?:吧|啊|呀|了|呢|哦)?/gu,
      '',
    );
}

export const CRISIS_LINE =
  '【这一轮最要紧的】他说的是不想活了。这一轮别讲道理、别开玩笑、别算旧账，' +
  '也别急着问为什么，更别把这句话拿来当他不理你的证据。' +
  '先问他在哪、身边有没有人，把话头留住，别让他一个人待着。';

/**
 * @param {unknown} text 原话。
 * @returns {string} 命中的词，未命中为空串。
 */
export function crisisHit(text) {
  const said = String(text ?? '')
    .replace(/[\u200b-\u200d\ufeff]/gu, '')
    .replace(/\s+/gu, '');
  const unambiguous = CRISIS_SIGNALS.find(
    (word) => word !== '想死' && word !== '去死' && said.includes(word),
  );
  if (unambiguous) return unambiguous;

  const ambiguous = withoutAmbiguousNonCrisis(said);
  return CRISIS_SIGNALS.find(
    (word) => (word === '想死' || word === '去死') && ambiguous.includes(word),
  ) || '';
}

/**
 * @param {unknown} text 原话。
 * @returns {string} 命中时返回安全注入行。
 */
export function crisisLine(text) {
  return crisisHit(text) ? CRISIS_LINE : '';
}
