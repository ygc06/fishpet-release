/**
 * 把账本数字翻译成不含数字的状态描述。
 *
 * 对齐旧 `feel_lang.py`：同一状态确定性选句，固定最多四句，
 * 不靠固定“开心/难过/生气”词轴选台词。
 *
 * @module dsh-fishpet-emotion/engine/feel-language
 */

import { activeExpressionSignals } from './expression-signals.js';
import { unresolvedAnger } from './anger.js';

const VALENCE = Object.freeze([
  [-Infinity, -78, ['整个人沉到底了，连说话都想省着', '心里空着一块，什么都不想抓，也不想被拉住']],
  [-78, -55, ['堵得厉害，喘气都得用力，不太想开口', '心里压着一块，提不起兴致，话也省了']],
  [-55, -35, ['心里发闷，一时缓不过来，说话带着凉', '有口气压在那儿，松不开']],
  [-35, -16, ['有点不痛快，但没到翻脸，话少了一点', '存了个小疙瘩，还没到要说的程度']],
  [-16, 6, ['没什么起伏，能好好说话', '平着，不冷不热，说什么都行']],
  [6, 30, ['心情还行，愿意接话，也愿意顺着聊', '心里松着，不费劲，随便聊聊都行']],
  [30, 60, ['心情不错，话比平时多', '心里亮着，愿意主动搭话，也愿意逗两句']],
  [60, Infinity, ['心情很好，藏不住，说话带着笑', '整个人是轻的，想多聊两句，也不想装']],
]);

const AROUSAL_TOP = Object.freeze(['整个人顶到头了，手有点抖', '脑子嗡嗡的，坐着也停不下来']);
const AROUSAL_HIGH = Object.freeze(['身上是提着的，坐不太稳', '手脚有点发紧，动作比平时快']);
const AROUSAL_UP = Object.freeze(['比平时精神，动作快半拍', '人有点起劲']);
const AROUSAL_DOWN = Object.freeze(['人静下来了，动作慢', '身上是松的、往下沉的']);
const AROUSAL_LOW = Object.freeze(['很安静，动作少', '整个人收着，动得少']);
const AROUSAL_BOTTOM = Object.freeze(['几乎不动，眼神发直', '一句话都不想说，坐在那儿发呆']);
const HELD_ANGER = Object.freeze([
  '火还在往上顶，不是想哭，是想把话顶回去',
  '这口气没消，越被轻描淡写越来火',
]);

const TRUST_HIGH = Object.freeze(['他说什么她先当真，不往坏处猜', '不防他，也不翻旧账，话敢往深了说']);
const TRUST_MIDHIGH = Object.freeze(['愿意把话当真，也愿意等他解释', '还信得过，不往坏处想']);
const TRUST_DOUBT = Object.freeze(['有点防备了，他说什么她先掂量是不是哄她', '心里存着疑，话会往回缩']);
const TRUST_LOW = Object.freeze(['不太敢信了，好话也当客气听', '心里那扇门关了一半，先看他做什么']);

const BODY = Object.freeze([
  [-Infinity, 18, ['身体快到底了，撑不住几句话，坐着都想靠着', '累到发虚，脑子是糊的，说话只剩短句']],
  [18, 38, ['人挺累的，懒得动，说话不太想费劲', '有点撑不住，想躺着，不想应付人']],
  [38, 62, ['身体还行，正常过日子', '状态一般，能聊，但不会主动找事做']],
  [62, 82, ['精神还不错，坐得住，不觉得乏', '身上有劲，愿意多说两句']],
  [82, Infinity, ['精神很足，闲不住，想找点事做', '人很清醒，话多，兴致高']],
]);

const CLINGY = Object.freeze([
  [-Infinity, 13, ['想一个人待着，谁找都想躲一下', '把自己收起来了，不太想被找到']],
  [13, 22, ['有点往回收，不太想主动，也不想先开口', '心里是想被找的，但不想先说']],
  [22, 40, ['平常的距离，不黏也不躲，他找她就接', '不主动也不推，顺其自然']],
  [40, 56, ['有点想找他，会多问一句，会等回复', '心思往他那边偏了一点，话里会带出来']],
  [56, Infinity, ['很想黏着，忍着没说，回得快，也不想显得太急', '整个人往他那边靠，一句不回就开始想']],
]);

const DOM_HIGH2 = Object.freeze(['腰杆是直的，话能说完，不怕把气氛弄僵', '底气足，敢开口要，也敢顶回去一句']);
const DOM_HIGH = Object.freeze(['说话有分量，不急着退', '心里有底，话摆得平']);
const DOM_LOW = Object.freeze(['气势是虚的，声音放低，话说一半就想收', '站不太住，想解释，又觉得解释不清']);
const DOM_LOW2 = Object.freeze(['底气空了，话到嘴边又咽回去，先看他脸色', '不敢要也不敢顶，怕一句话就把他推远']);

const MASK_LINE = Object.freeze({
  硬撑: '嘴上说着没事，那口气其实还堵在胸口，没真下去',
  反话: '话说得挺硬，说完自己先愣了，其实在等他回头',
  转移: '不想再往下说了，先把自己收起来，免得说得更难听',
});

function maskSignalText(mask) {
  const kind = String(mask?.kind || '').trim();
  const quote = String(mask?.q || '').trim();
  if (kind === '反话') {
    return quote ? `那句「${quote}」更像反话，其实还在等他回头` : MASK_LINE.反话;
  }
  if (kind === '转移') {
    return quote ? `她拿「${quote}」把话岔开了，其实不想再往下说` : MASK_LINE.转移;
  }
  if (kind === '硬撑') {
    return quote ? `嘴上说着「${quote}」，其实是在硬撑` : MASK_LINE.硬撑;
  }
  return '';
}

function surgeSignalText(surge) {
  const kind = String(surge?.kind || '').trim();
  if (!kind) return '';
  const action = {
    被抱: '刚才被抱住',
    被亲: '刚才被亲到',
    靠近: '刚才他靠得很近',
    表白: '刚才听见了像表白的话',
    夸到点上: '刚才被夸到了点上',
  }[kind] || `刚才${kind}`;
  const level = Number(surge.level || 1);
  const effect = level >= 3
    ? '心里一下乱了'
    : level >= 2
      ? '心里明显一热'
      : '心里轻轻动了一下';
  return `${action}，${effect}`;
}

function stingSignalText(sting) {
  const kind = String(sting?.kind || '').trim();
  const action = {
    贬低: '刚才被贬低了',
    羞辱: '刚才被羞辱了',
    翻旧账: '旧账刚被翻了出来',
    威胁: '刚才被威胁了',
    驱逐: '刚才被赶开了',
  }[kind];
  if (!action) return '';
  const level = Number(sting.level || 1);
  const effect = level >= 3
    ? '话扎得很深'
    : level >= 2
      ? '话明显扎到了心里'
      : '心里有一点发刺';
  return `${action}，${effect}`;
}

const HOT_WORDS = Object.freeze(['羞', '臊', '脸红', '心动', '心软', '软', '甜', '哄', '暖', '飘', '酥', '悸']);
const FIRE_WORDS = Object.freeze(['气', '恼', '烦', '不服', '顶', '炸', '火', '硬', '恨', '怒', '咬牙']);
const SINK_WORDS = Object.freeze(['委屈', '堵', '沉', '凉', '空', '难过', '酸', '憋', '闷', '怕', '慌', '愧', '歉', '疼']);

const COMBINE = Object.freeze({
  '热|2': '脸有点烫，话快半拍，声音是软的',
  '热|1': '心里有点飘，说话轻了半度',
  '热|0': '说不出口，只想低着头，话很少',
  '火|2': '话顶着说，句子短，一步不让',
  '火|1': '口气不算软，但还收得住',
  '火|0': '懒得吵，也不想解释',
  '沉|2': '心里乱，坐不太住，说话没头绪',
  '沉|1': '话不多，说得慢',
  '沉|0': '不想开口，回得很省',
  '混|2': '几股劲一起上来，会冲一句，也会软下来',
  '混|1': '说不清哪股更重，话有点犹豫',
  '混|0': '都压着，不想说',
  '|2': '身上是提着的，坐不太住',
  '|1': '',
  '|0': '人很静，动作慢，话少',
});

/**
 * @param {string[]} words
 * @returns {string}
 */
export function mixHint(words = []) {
  const list = Array.isArray(words) ? words.map((word) => String(word ?? '')).filter((word) => word.trim()) : [];
  if (list.length >= 2) return '心里好几股劲缠在一块，说不清哪个更重，话会有点犹豫';
  if (list.length === 1) return '心里就这一股，说话干脆';
  return '';
}

/**
 * @param {string[]} words
 * @returns {'热'|'火'|'沉'|'混'|''}
 */
export function wordClass(words = []) {
  const list = Array.isArray(words) ? words.map(String) : [];
  const hits = [];
  for (const word of list) {
    if (HOT_WORDS.some((key) => word.includes(key))) hits.push('热');
    else if (FIRE_WORDS.some((key) => word.includes(key))) hits.push('火');
    else if (SINK_WORDS.some((key) => word.includes(key))) hits.push('沉');
  }
  const unique = [...new Set(hits)].sort();
  return unique.length >= 2 ? '混' : unique[0] || '';
}

/**
 * @param {string[]} words
 * @param {number} arousal
 * @returns {string}
 */
export function combineHint(words = [], arousal = 0) {
  const level = Number(arousal) >= 55 ? 2 : Number(arousal) <= -25 ? 0 : 1;
  return COMBINE[`${wordClass(words)}|${level}`] || '';
}

/**
 * @param {object} mood
 * @param {object} life
 * @param {string} _emotion 已废弃参数，保留兼容。
 * @param {number} [seed]
 * @param {number} [maxSentences]
 * @param {number} [now] Unix 秒，测试可注入。
 * @returns {string}
 */
export function describeFeelings(mood = {}, life = {}, _emotion = '', seed, maxSentences = 4, now = Date.now() / 1000) {
  const v = number(mood.valence, 10);
  const arousal = number(mood.arousal, 0);
  const energy = number(mood.energy, 65);
  const clingy = number(mood.clingy, 30);
  const dominance = number(mood.dominance, 0);
  const trust = number(mood.trust, 10);
  const vitality = number(life?.energy, energy);
  const sd = Number.isFinite(Number(seed)) ? Number(seed) : v * 3.1 + arousal * 1.7 + clingy * 0.9;

  const angerHeld = unresolvedAnger(mood, mood, now);
  const parts = [angerHeld ? pick(HELD_ANGER, sd) : band(VALENCE, v, sd)];
  const signals = activeExpressionSignals(mood, now);
  const signalLines = [
    maskSignalText(signals.mask),
    stingSignalText(signals.sting),
    surgeSignalText(signals.surge),
  ].filter(Boolean);
  if (signalLines.length) parts.unshift(signalLines.join('；'));

  parts.push(band(BODY, Math.min(energy, vitality), sd));
  parts.push(band(CLINGY, clingy, sd));

  const extra = [];
  if (arousal >= 80) extra.push(pick(AROUSAL_TOP, sd));
  else if (arousal >= 55) extra.push(pick(AROUSAL_HIGH, sd));
  else if (arousal >= 25) extra.push(pick(AROUSAL_UP, sd));
  else if (arousal <= -80) extra.push(pick(AROUSAL_BOTTOM, sd));
  else if (arousal <= -55) extra.push(pick(AROUSAL_LOW, sd));
  else if (arousal <= -25) extra.push(pick(AROUSAL_DOWN, sd));

  if (dominance >= 55) extra.push(pick(DOM_HIGH2, sd));
  else if (dominance >= 24) extra.push(pick(DOM_HIGH, sd));
  else if (dominance <= -55) extra.push(pick(DOM_LOW2, sd));
  else if (dominance <= -24) extra.push(pick(DOM_LOW, sd));

  if (trust >= 70) extra.push(pick(TRUST_HIGH, sd));
  else if (trust >= 30) extra.push(pick(TRUST_MIDHIGH, sd));
  else if (trust <= -70) extra.push(pick(TRUST_LOW, sd));
  else if (trust <= -30) extra.push(pick(TRUST_DOUBT, sd));

  const out = parts.slice(0, maxSentences);
  for (const line of extra) {
    if (out.length >= maxSentences + 1) break;
    if (!out.some((existing) => tooSimilar(line, existing))) out.push(line);
  }
  return '【她此刻】' + out.filter(Boolean).join('；') + '。';
}

function number(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pick(sequence, seed) {
  if (!sequence.length) return '';
  return sequence[Math.abs(Math.trunc(seed)) % sequence.length];
}

function band(table, value, seed) {
  for (const [low, high, text] of table) {
    if (low <= value && value < high) return pick(text, seed);
  }
  return pick(table[table.length - 1][2], seed);
}

export function grams(text, size = 3) {
  const clean = String(text ?? '').replace(/[，。；、,.;:：！？!? ]/g, '');
  const out = new Set();
  for (let i = 0; i < Math.max(0, clean.length - size + 1); i += 1) {
    out.add(clean.slice(i, i + size));
  }
  return out;
}

function tooSimilar(a, b) {
  if (!a || !b) return false;
  const right = grams(b);
  return [...grams(a)].some((part) => right.has(part));
}
