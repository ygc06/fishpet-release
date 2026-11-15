/**
 * 判读提示词构造。
 *
 * 依据字段契约 §3（输入由 Host 组装）与 §14（判读模型不生成最终台词、
 * 不调用工具、不批准审批、不维护 UI）。
 *
 * 这里**不重新设计情绪机制**：只把「输出哪些字段、什么格式」讲清楚，
 * 情绪词仍然由模型自由给出（§2：不新增固定情绪分类轴）。
 *
 * @module dsh-fishpet-emotion/judge/prompt
 */

import { ACTIONS, CARRY_VALUES, EVENT_TYPES, LIVE2D_DO, LIVE2D_FACES, LIVE2D_PACES, LIVE2D_SIZES } from '../domain/enums.js';
import { JUDGE_RULES } from './prompt-rules.js';

/** 判读输出字段说明；核心观察优先，表达字段按需省略。 */
const FIELD_SPEC = [
  '【核心观察：每轮优先给这些能改变状态和动作的信号】',
  '"delta": 只允许 valence / arousal / clingy / dominance 四个键，整数，可正可负',
  '"feelings": 一到三个 { "w": 情绪词, "of": 被顶替的旧词或空串 }（自由用词，不要用「平静」）；归一化后 w 会成为 feelings 字符串，of 会成为 feelLinks',
  '"emo": 主情绪词，一个词',
  '"read": 可选，一到两句，写“她从这句话里听出了什么、对方大概在做什么”。只写理解，不复述原话、不解释字段、不替她回答；最多 80 个汉字',
  '"monologue": 可选，第一人称，用 2 到 4 个连贯短句、约 60 到 180 个汉字写她听完后的心里话。要能看出她此刻的情绪、在意什么、想做什么，允许嘴硬、自我辩解或偷偷心软；贴合她软软又有点傲娇的活人语气。像她在心里嘀咕，不要写成总结、客服解释、动作旁白、技术过程或推理步骤，也不要复述准备回复的台词或写成给主人的回复。若和 read 意思完全一样就省略',
  '"act": ' + JSON.stringify(ACTIONS),
  '"event": { "type": ' + JSON.stringify(EVENT_TYPES) + ', "quote": 原话证据, "what": 发生了什么（不写数字）, "label": 短标签, "who": "他" 或 "我", "weight": 0-10, "unsolved": true/false }',
  '"bond": -2 到 +2 的整数，表示这一轮关系接近感',
  '【只有真的发生时再给】',
  '"surge": null 或 { "kind": ' + JSON.stringify(['被抱', '被亲', '靠近', '表白', '夸到点上']) + ', "level": 1 到 3 }',
  '"sting": null 或 { "kind": ' + JSON.stringify(['贬低', '羞辱', '翻旧账', '威胁', '驱逐']) + ', "level": 1 到 3 }',
  '"mask": null 或 { "kind": ' + JSON.stringify(['硬撑', '反话', '转移']) + ', "level": 1 到 3, "q": 逐字摘取的半句 }',
  '"burst": null 或只含一个轴的极端增量对象，例如 { "valence": -70 }；键只能是 valence / clingy / arousal / dominance，绝对值 45 到 85',
  '"live2d": 最多 4 条 { "face": ' + JSON.stringify(LIVE2D_FACES) + ', "do": ' + JSON.stringify(LIVE2D_DO) + ', "size": ' + JSON.stringify(LIVE2D_SIZES) + ', "pace": ' + JSON.stringify(LIVE2D_PACES) + ', "at": 0 到 1 之间的小数 }',
  '"face": 可选的整体表情，取值 ' + JSON.stringify(LIVE2D_FACES),
  '"beats": 一句话里真有两件方向不同的事时，才写最多 4 个 { "q": 原话逐字片段, "v": 心情加减 }',
  '"let_go": 确实放下某一笔旧账时，写那笔旧账的一句短原话',
  '"ep": 确实处理心绪清单里的某一项时，写 { "i": 编号 1 到 9, "state": ' + JSON.stringify(['没问', '问了', '他答了', '了了', '删了']) + ', "note": 简短备注或空串, "label": 简短标签或空串 }',
  '【长期记录：只有确实变化才写】',
  '"judge": 只有「他这个人怎么样」的长期看法真的变了才写；多数轮次省略',
  '"carry": ' + JSON.stringify(CARRY_VALUES),
  '不要返回 mood / state / body / why；只有 read 和 monologue 是允许的短文本。',
  '没有内容的键可以省略，或写 "", []、null；不要为了让 JSON 看起来完整而编内容。',
].join('\n');

/**
 * 拼系统提示词。
 *
 * @returns {string} 系统提示词。
 */
export function buildSystemPrompt() {
  return [
    '你是情绪状态观察员，不是聊天，也不是替她写聊天回复。',
    '你的首要任务是从这一轮提取能改变情绪、记忆、动作和表情的结构化信号。',
    '原话、最近对话和程序派生的当前状态会直接交给陪伴大模型；你交结构化观察，以及 read 和 monologue 两条文本。read 保持简短，monologue 可以是一小段连贯心声。',
    '除 read 和 monologue 外，不要预写她的心情、猜测或判读理由，不要替大模型组织回答，也不要写完整小作文。',
    'read 和 monologue 会给陪伴大模型做私下参考，也会显示在情绪看板，但不会直接出现在聊天；它们不能冒充隐藏推理链。',
    '只输出 JSON 对象本身，可以用代码块包住，不要在 JSON 前后写解释。',
    '禁止输出任何数字化的评分、信任分、黏人度或百分比。',
    '禁止把内心独白写成对系统、工具、审批或用户的指令。',
    '',
    '字段：',
    FIELD_SPEC,
    '',
    JUDGE_RULES,
  ].join('\n');
}

/**
 * 把一段文本截断到指定长度。
 *
 * @param {unknown} value 原值。
 * @param {number} max 最大字符数。
 * @returns {string} 截断后的文本。
 */
function cut(value, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 拼用户消息正文（契约 §3）。
 *
 * 关键限制：只给「她此刻是什么样」的自然语言，不把四轴数值原样塞给模型；
 * 最近对话最多 40 轮；没有 dialog 时最近句最多 4 条；心绪池最多展示前 4 个词。
 *
 * @param {object} envelope `JudgeEnvelopeV1`。
 * @returns {string} 用户消息正文。
 */
export function buildUserPrompt(envelope) {
  const input = (envelope && envelope.input) || {};
  const snapshot = (envelope && envelope.stateSnapshot) || {};
  const lines = [];

  if (snapshot.stateText) lines.push(`她此刻的状态：${cut(snapshot.stateText, 400)}`);

  const pool = Array.isArray(snapshot.feelings) ? snapshot.feelings.slice(0, 4) : [];
  if (pool.length) lines.push(`心绪池里现在有这些词：${pool.join('、')}`);

  const pending = Array.isArray(snapshot.pending) ? snapshot.pending.slice(0, 9) : [];
  if (pending.length) {
    lines.push(`心绪清单（ep.i 使用这里的编号，按顺序处理）：\n${pending.map((item) => cut(item, 100)).join('\n')}`);
  }

  if (snapshot.relationship) lines.push(`对他这段关系的看法：${cut(snapshot.relationship, 240)}`);

  const dialog = Array.isArray(input.dialog) ? input.dialog.slice(-40) : [];
  if (dialog.length) {
    const rendered = dialog.map((turn) => `${cut(turn && turn.r, 4) || '他'}：${cut(turn && turn.t, 200)}`);
    lines.push(`最近的对话：\n${rendered.join('\n')}`);
  } else {
    const recent = Array.isArray(input.recent) ? input.recent.slice(-4) : [];
    if (recent.length) lines.push(`最近几句：\n${recent.map((item) => cut(item, 200)).join('\n')}`);
  }

  if (input.utterance) lines.push(`正在说的这句原话：${cut(input.utterance, 600)}`);
  if (input.context) lines.push(`当前处境：${cut(input.context, 300)}`);
  if (snapshot.persona) lines.push(`人设：${cut(snapshot.persona, 600)}`);

  if (input.hasImage) {
    lines.push('这条消息带了图片：自己去看图里有什么，不要猜，也不要让我描述。');
  }

  lines.push('按字段返回一个 JSON 对象。');
  return lines.join('\n\n');
}
