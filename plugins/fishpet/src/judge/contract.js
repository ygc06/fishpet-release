/**
 * 判读结果契约：JSON 提取 + 字段归一化（降级而不整轮失败）。
 *
 * 依据 `DSH-FishPet-情绪判读字段契约-v1-2026-11-12.md`：
 * §4 JSON 提取容错、§5 delta 限幅、§6 beats、§7 feelings/emo、
 * §8 动作、§9 事件、§10 surge/sting/mask/ep、§11 文本字段、§12 Live2D cue。
 *
 * 这里**只做校验与裁剪**，不落账、不改状态、不调用模型；
 * 任何单字段坏掉都只丢该字段并写 `degraded`，整轮只有在「一个可用字段都没有」时失败。
 *
 * @module dsh-fishpet-emotion/judge/contract
 */

import {
  ACT_FALLBACK,
  ACTIONS,
  BOND_LIMITS,
  BURST_LIMITS,
  CARRY_VALUES,
  DELTA_KEYS,
  DELTA_LIMITS,
  EP_FALLBACK,
  EP_LIMITS,
  EP_STATES,
  EVENT_FALLBACK,
  EVENT_LIMITS,
  EVENT_TYPES,
  FEELINGS_LIMITS,
  FEELING_STOPWORDS,
  JUDGE_ERRORS,
  LEVEL_LIMITS,
  LIVE2D_DO,
  LIVE2D_FACES,
  LIVE2D_LIMITS,
  LIVE2D_PACES,
  LIVE2D_SIZES,
  MASK_KINDS,
  MASK_QUOTE_CHARS,
  STATE_BAD_WORDS,
  STATE_COMMAND_WORDS,
  STING_KINDS,
  SURGE_KINDS,
  TEXT_LIMITS,
} from '../domain/enums.js';
import {
  BOUNDARY_SIGNALS,
  STRONG_EVENTS,
  findBoundarySignal,
  resolveAction,
} from '../engine/actions.js';

export { BOUNDARY_SIGNALS, STRONG_EVENTS } from '../engine/actions.js';

const FENCE_RE = /```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/;

/**
 * 去掉 Markdown 代码围栏；没有围栏时原样返回。
 *
 * @param {string} text 模型原始输出。
 * @returns {string} 去围栏后的文本。
 */
export function stripFences(text) {
  const raw = typeof text === 'string' ? text : '';
  const hit = raw.match(FENCE_RE);
  return (hit ? hit[1] : raw).trim();
}

/**
 * 扫出文本里所有括号配平的 `{...}` 片段（考虑字符串与转义）。
 *
 * 契约 §4 第 4 步：按括号深度和字符串转义逐段配对。
 *
 * @param {string} text 待扫描文本。
 * @returns {string[]} 按出现顺序排列的候选对象片段。
 */
export function scanBalancedObjects(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          out.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return out;
}

/**
 * 按契约 §4 的顺序提取一个 JSON 对象。
 *
 * @param {string} text 模型原始输出。
 * @returns {{ok: true, value: object} | {ok: false, code: string}} 提取结果。
 */
export function extractJsonObject(text) {
  const body = stripFences(text);
  if (!body) return { ok: false, code: JUDGE_ERRORS.EMPTY };

  const attempt = (candidate) => {
    try {
      const value = JSON.parse(candidate);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  };

  const whole = attempt(body);
  if (whole) return { ok: true, value: whole };

  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const outer = attempt(body.slice(first, last + 1));
    if (outer) return { ok: true, value: outer };
  }

  for (const candidate of scanBalancedObjects(body)) {
    const value = attempt(candidate);
    if (value) return { ok: true, value };
  }

  return { ok: false, code: JUDGE_ERRORS.BAD_JSON };
}

/**
 * 转成有限数字；接受数值字符串。
 *
 * @param {unknown} raw 原始值。
 * @returns {number|null} 有限数字或 null。
 */
function finiteNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim()) {
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 限幅取整。
 *
 * @param {number} n 数字。
 * @param {number} limit 绝对值上限。
 * @returns {number} 限幅后的整数。
 */
function clampRound(n, limit) {
  const v = Math.max(-limit, Math.min(limit, n));
  return Math.round(v);
}

/**
 * 去掉所有数字（契约 §9 `what`、§11 多处「不含数字」）。
 *
 * @param {string} text 文本。
 * @returns {string} 去数字后的文本。
 */
export function stripDigits(text) {
  return String(text == null ? '' : text)
    .replace(/[0-9０-９]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 规整文本：去控制字符、折叠空白、按需去数字、截断。
 *
 * @param {unknown} raw 原始值。
 * @param {{max?: number, stripDigit?: boolean}} [options] 选项。
 * @returns {string} 规整后的文本。
 */
function cleanText(raw, options = {}) {
  const max = options.max == null ? 0 : options.max;
  let text = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (options.stripDigit) text = stripDigits(text);
  if (max > 0 && text.length > max) text = text.slice(0, max).trim();
  return text;
}

const CHARACTER_TEXT_INTERNAL_RE = /(系统提示|提示词|系统消息|模型输出|模型内部|工具调用|函数调用|内部推理|JSON|schema|reasoning|assistant|prompt|tool\s*call)/i;

function normalizeCharacterText(raw, field, max) {
  const degraded = [];
  const original = String(raw == null ? '' : raw).trim();
  if (!original) return { text: '', degraded };
  const value = cleanText(original, { max })
    .replace(/^["“”]+|["“”]+$/g, '')
    .trim();
  if (!value) return { text: '', degraded: [`${field}.empty`] };
  if (original.length > max) degraded.push(`${field}.truncated`);
  if (CHARACTER_TEXT_INTERNAL_RE.test(value)) {
    return { text: '', degraded: [`${field}.internal-leak`] };
  }
  return { text: value, degraded };
}

/**
 * 看板独白只接受一小段角色化文字。它不是隐藏推理链、工具过程或系统提示的
 * 展示通道，因此命中内部标记时整段丢弃，而不是截断后继续显示。
 *
 * @param {unknown} raw 模型给出的 monologue。
 * @returns {{text: string, degraded: string[]}} 清理结果。
 */
export function normalizeMonologue(raw) {
  return normalizeCharacterText(raw, 'monologue', TEXT_LIMITS.monologue);
}

/**
 * `read` 是“她怎么理解他这句话”的短解释，供大模型与看板参考；它不参与
 * 情绪落账，也不能单独证明一轮判读成功。
 *
 * @param {unknown} raw 模型给出的 read。
 * @returns {{text: string, degraded: string[]}} 清理结果。
 */
export function normalizeRead(raw) {
  return normalizeCharacterText(raw, 'read', TEXT_LIMITS.read);
}

/**
 * `state` 专项清理：去数字、去坏词、去命令句式（契约 §11）。
 *
 * 判读内心不能变成对 DSH 工具或审批的指令，所以命令句式整句丢弃而不是保留。
 *
 * @param {unknown} raw 原始 state。
 * @returns {{text: string, degraded: string[]}} 清理结果。
 */
export function cleanState(raw) {
  const degraded = [];
  let text = cleanText(raw, { max: TEXT_LIMITS.state[1] });
  if (!text) return { text: '', degraded };

  const before = text;
  text = stripDigits(text);
  if (text !== before) degraded.push('state.digits');

  for (const word of STATE_BAD_WORDS) {
    if (text.includes(word)) {
      text = text.split(word).join(' ');
      if (!degraded.includes('state.badword')) degraded.push('state.badword');
    }
  }
  for (const word of STATE_COMMAND_WORDS) {
    if (text.includes(word)) {
      text = text.split(word).join(' ');
      if (!degraded.includes('state.command')) degraded.push('state.command');
    }
  }
  text = text.replace(/\s+/g, ' ').trim();

  if (text.length < TEXT_LIMITS.state[0]) {
    degraded.push('state.too-short');
    return { text: '', degraded };
  }
  return { text, degraded };
}

/**
 * 归一化 `delta`（契约 §5）：只接受四个轴、限幅取整、丢 NaN。
 *
 * @param {unknown} raw 原始 delta 对象。
 * @returns {{delta: Record<string, number>, degraded: string[]}} 结果。
 */
export function normalizeDelta(raw) {
  const out = {};
  const degraded = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { delta: out, degraded };
  }
  for (const key of DELTA_KEYS) {
    if (!(key in raw)) continue;
    const n = finiteNumber(raw[key]);
    if (n === null) {
      degraded.push(`delta.${key}.not-finite`);
      continue;
    }
    const clamped = clampRound(n, DELTA_LIMITS[key]);
    if (clamped !== Math.round(n)) degraded.push(`delta.${key}.clamped`);
    out[key] = clamped;
  }
  if ('energy' in raw) degraded.push('delta.energy.ignored');
  if ('targets' in raw) degraded.push('delta.targets.ignored');
  return { delta: out, degraded };
}

/**
 * 归一化 `beats`（契约 §6）：≤4 项、原话逐字存在、v 限幅。
 *
 * @param {unknown} raw 原始 beats。
 * @param {string} utterance 当前原话，用于逐字核对。
 * @returns {{beats: object[], degraded: string[]}} 结果。
 */
export function normalizeBeats(raw, utterance) {
  const beats = [];
  const degraded = [];
  if (raw == null) return { beats, degraded };
  if (!Array.isArray(raw)) {
    degraded.push('beats.not-array');
    return { beats, degraded };
  }
  const said = cleanText(utterance, {});
  // 原话为空时，任何拍点都没有可核对的对象，直接全丢（R1 派工单 P0-6）。
  if (!said && raw.length) degraded.push('beats.no-utterance');
  for (const item of said ? raw.slice(0, 4) : []) {
    if (!item || typeof item !== 'object') {
      degraded.push('beats.item.invalid');
      continue;
    }
    const q = cleanText(item.q, { max: 20 });
    const v = finiteNumber(item.v);
    if (!q || v === null) {
      degraded.push('beats.item.incomplete');
      continue;
    }
    if (Math.abs(v) < 1) {
      degraded.push('beats.item.too-small');
      continue;
    }
    if (!said.includes(q)) {
      degraded.push('beats.quote-missing');
      continue;
    }
    const clamped = clampRound(v, DELTA_LIMITS.valence);
    if (clamped !== Math.round(v)) degraded.push('beats.value.clamped');
    beats.push({ q, v: clamped, of: cleanText(item.of, { max: 12 }) || '' });
  }
  if (raw.length > 4) degraded.push('beats.truncated');
  return { beats, degraded };
}

/**
 * 归一化 `feelings` 与 `emo`（契约 §7）。
 *
 * @param {unknown} rawFeelings 原始 feelings。
 * @param {unknown} rawEmo 原始 emo。
 * @returns {{feelings: string[], emo: string, feelLinks: object[], degraded: string[]}} 结果。
 */
export function normalizeFeelings(rawFeelings, rawEmo) {
  const feelings = [];
  const feelLinks = [];
  const degraded = [];
  const list = Array.isArray(rawFeelings) ? rawFeelings : [];

  for (const item of list) {
    let word = '';
    let of = '';
    if (typeof item === 'string') {
      word = cleanText(item, { max: 12 });
    } else if (item && typeof item === 'object') {
      word = cleanText(item.w, { max: 12 });
      of = cleanText(item.of, { max: 12 });
    }
    if (!word) {
      degraded.push('feelings.empty');
      continue;
    }
    if (FEELING_STOPWORDS.includes(word)) {
      degraded.push('feelings.stopword');
      continue;
    }
    if (feelings.includes(word)) {
      degraded.push('feelings.duplicate');
      continue;
    }
    if (feelings.length >= FEELINGS_LIMITS.maxItems) {
      degraded.push('feelings.truncated');
      continue;
    }
    feelings.push(word);
    if (of) feelLinks.push({ w: word, of });
  }

  let emo = cleanText(rawEmo, { max: 12 });
  if (emo && FEELING_STOPWORDS.includes(emo)) {
    degraded.push('emo.stopword');
    emo = '';
  }
  if (!emo && feelings.length) emo = feelings[0];
  if (!emo) {
    emo = '空';
    degraded.push('emo.fallback');
  }
  return { feelings, emo, feelLinks, degraded };
}

/**
 * 归一化 `event`（契约 §9）。
 *
 * @param {unknown} raw 原始 event。
 * @returns {{event: object, degraded: string[]}} 结果。
 */
export function normalizeEvent(raw) {
  const degraded = [];
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (raw != null && src !== raw) degraded.push('event.not-object');

  let type = cleanText(src.type, { max: 8 });
  if (!EVENT_TYPES.includes(type)) {
    if (type) degraded.push('event.type');
    type = EVENT_FALLBACK;
  }

  let quote = cleanText(src.quote, { max: EVENT_LIMITS.quoteChars });
  let unsolved = src.unsolved === true;
  if (type === EVENT_FALLBACK) {
    if (quote) degraded.push('event.quote.dropped');
    quote = '';
    unsolved = false;
  }

  let what = cleanText(src.what, { max: EVENT_LIMITS.whatChars, stripDigit: true });
  let whatHadDigit = false;
  if (String(src.what ?? '') && what !== cleanText(src.what, { max: EVENT_LIMITS.whatChars })) {
    degraded.push('event.what.digit');
    whatHadDigit = true;
  }

  const label = cleanText(src.label, { max: EVENT_LIMITS.labelChars });
  const who = cleanText(src.who, { max: 2 }) === '我' ? '我' : '他';

  let weight = finiteNumber(src.weight);
  if (weight === null) weight = 0;
  const clamped = Math.max(EVENT_LIMITS.weightMin, Math.min(EVENT_LIMITS.weightMax, Math.round(weight)));
  if (clamped !== Math.round(weight)) degraded.push('event.weight.clamped');
  weight = clamped;
  // 权重一旦跟「带数字的描述」绑在一起就不可信（fixture unknown-event-and-degraded-state）。
  if (!what || whatHadDigit) {
    if (weight !== 0) degraded.push(what ? 'event.weight.digit' : 'event.weight.no-what');
    weight = 0;
  }

  return { event: { type, quote, what, label, who, weight, unsolved }, degraded };
}

/**
 * 动作归一化 + 证据门槛（契约 §8）。
 *
 * `normalizeAct` 只做白名单；`resolveAct` 才按旧 `acts.resolve()` 的规则把
 * 「认一句 / 划界退开」降级为「说难受」。两层分开，便于层 2 改规则而不动解析。
 *
 * @param {unknown} raw 原始 act。
 * @returns {{act: string, degraded: string[]}} 白名单结果（非法时为 ''）。
 */
export function normalizeAct(raw) {
  const act = cleanText(raw, { max: 8 });
  if (!act) return { act: '', degraded: ['act.missing'] };
  if (!ACTIONS.includes(act)) return { act: '', degraded: ['act.illegal'] };
  return { act, degraded: [] };
}

/**
 * 应用动作证据门槛（逐条对齐旧 `acts.py:54-85` 的 `resolve()`）。
 *
 * 旧实现的三段判断，这里一段不省：
 * 1. 原话里出现 `_LIMIT` 那组「管她」的话，且模型给的是「靠近/说难受/没给」→ 直接抬到
 *    「划界退开」（模型不敢划线时，规则替她把线摆出来）；
 * 2. 模型给「认一句」→ 必须摘得出他原话，且这一轮不是「亲近」，否则退「说难受」；
 * 3. 模型给「划界退开」→ 必须命中 `_LIMIT`，或事件属于 `挑刺/失约/拒绝/冷落` 且摘得出
 *    原话，否则退「说难受」。**普通/亲近/未知事件都不能靠宽泛词自动升级。**
 *
 * 一条大原则（旧文件开头注释）：动作的强度不许超过证据的强度。
 *
 * @param {string} act 白名单后的动作，可为空。
 * @param {{type: string, quote: string}} event 归一化事件。
 * @param {string} utterance 当前原话。
 * @returns {{act: string, degraded: string[], reason?: string}} 最终动作。
 */
export function resolveAct(act, event, utterance) {
  const said = cleanText(utterance, {});
  const quote = cleanText(event && event.quote, {});
  // 摘句必须逐字存在于这一轮原话里才算证据；原话为空时一律无证据（P0-6）。
  const hasQuote = Boolean(said) && Boolean(quote) && said.includes(quote);
  const wanted = cleanText(act, { max: 8 });
  if (!wanted) {
    const boundary = findBoundarySignal(said);
    if (!boundary) {
      return {
        act: '',
        degraded: [],
        reason: '观察员没有给出动作，程序也不凭感觉补一个',
      };
    }
    return {
      act: '划界退开',
      degraded: ['act.boundary-upgrade'],
      reason: `他说了「${boundary}」——这是管她，字面就够硬`,
    };
  }
  const resolved = resolveAction(wanted, (event && event.type) || EVENT_FALLBACK, hasQuote, said);
  return {
    act: resolved.act,
    degraded: resolved.degraded || [],
    reason: resolved.reason,
  };
}

/**
 * 归一化 `surge` / `sting` / `mask` / `ep`（契约 §10）。
 *
 * @param {object} src 模型原始对象。
 * @returns {{signal: object, degraded: string[]}} 结果。
 */
export function normalizeSignals(src) {
  const degraded = [];
  const signal = {};

  const level = (raw) => {
    const n = finiteNumber(raw);
    if (n === null) return LEVEL_LIMITS.min;
    return Math.max(LEVEL_LIMITS.min, Math.min(LEVEL_LIMITS.max, Math.round(n)));
  };

  if (src.surge && typeof src.surge === 'object') {
    const kind = cleanText(src.surge.kind, { max: 8 });
    if (SURGE_KINDS.includes(kind)) signal.surge = { kind, level: level(src.surge.level) };
    else degraded.push('surge.kind');
  }
  if (src.sting && typeof src.sting === 'object') {
    const kind = cleanText(src.sting.kind, { max: 8 });
    if (STING_KINDS.includes(kind)) signal.sting = { kind, level: level(src.sting.level) };
    else degraded.push('sting.kind');
  }
  if (src.mask && typeof src.mask === 'object') {
    const kind = cleanText(src.mask.kind, { max: 8 });
    if (MASK_KINDS.includes(kind)) {
      signal.mask = { kind, level: level(src.mask.level), q: cleanText(src.mask.q, { max: MASK_QUOTE_CHARS }) };
    } else {
      degraded.push('mask.kind');
    }
  }
  if (src.ep && typeof src.ep === 'object') {
    const idx = finiteNumber(src.ep.i);
    const state = cleanText(src.ep.state, { max: 8 });
    if (!EP_STATES.includes(state)) degraded.push('ep.state');
    signal.ep = {
      i: idx === null ? 0 : Math.max(EP_LIMITS.indexMin, Math.min(EP_LIMITS.indexMax, Math.round(idx))),
      state: EP_STATES.includes(state) ? state : EP_FALLBACK,
      note: cleanText(src.ep.note, { max: EP_LIMITS.noteChars }),
      label: cleanText(src.ep.label, { max: EP_LIMITS.labelChars }),
    };
  }
  return { signal, degraded };
}

/**
 * 归一化 Live2D cue（契约 §12）：白名单、at 夹到 0..1 保留 3 位、去重排序、最多留 4 条。
 *
 * 接受两种形状：裸数组，或 `{ face, cues | live2d }`（旧 `mind_llm.validate()` 的形态）。
 * 顶层 `face` 同样过白名单，非法则丢弃并记降级。
 *
 * @param {unknown} raw 原始 live2d 数组或 `{face, cues}` 对象。
 * @returns {{face: string, live2d: object[], degraded: string[]}} 结果。
 */
export function normalizeLive2d(raw) {
  const degraded = [];
  if (raw == null) return { face: '', live2d: [], degraded };

  let faceWanted = '';
  let list = raw;
  if (!Array.isArray(raw) && typeof raw === 'object') {
    faceWanted = cleanText(raw.face, { max: 8 });
    list = Array.isArray(raw.cues) ? raw.cues : Array.isArray(raw.live2d) ? raw.live2d : [];
  }
  if (!Array.isArray(list)) {
    degraded.push('live2d.not-array');
    return { face: '', live2d: [], degraded };
  }

  let face = '';
  if (faceWanted) {
    if (LIVE2D_FACES.includes(faceWanted)) face = faceWanted;
    else degraded.push('live2d.face.illegal');
  }

  const kept = [];
  for (const item of list.slice(0, LIVE2D_LIMITS.maxChecked)) {
    if (!item || typeof item !== 'object') {
      degraded.push('live2d.item.invalid');
      continue;
    }
    const doWord = cleanText(item.do, { max: 8 });
    const itemFace = cleanText(item.face, { max: 8 });
    if (doWord && !LIVE2D_DO.includes(doWord)) {
      degraded.push('live2d.do.illegal');
      continue;
    }
    if (itemFace && !LIVE2D_FACES.includes(itemFace)) {
      degraded.push('live2d.face.illegal');
      continue;
    }
    if (!doWord && !itemFace) {
      degraded.push('live2d.item.empty');
      continue;
    }
    let size = cleanText(item.size, { max: 2 });
    if (!LIVE2D_SIZES.includes(size)) {
      if (size) degraded.push('live2d.size.fallback');
      size = '中';
    }
    let pace = cleanText(item.pace, { max: 4 });
    if (!LIVE2D_PACES.includes(pace)) {
      if (pace) degraded.push('live2d.pace.fallback');
      pace = '自然';
    }
    const atRaw = finiteNumber(item.at);
    const at = atRaw === null ? 0 : Number(Math.max(0, Math.min(1, atRaw)).toFixed(LIVE2D_LIMITS.atDecimals));
    kept.push({ face: itemFace, do: doWord, size, pace, at });
  }
  if (list.length > LIVE2D_LIMITS.maxChecked) degraded.push('live2d.truncated');

  const seen = new Set();
  const unique = [];
  for (const cue of kept.sort((a, b) => a.at - b.at)) {
    const key = `${cue.face}|${cue.do}|${cue.at}`;
    if (seen.has(key)) {
      degraded.push('live2d.duplicate');
      continue;
    }
    seen.add(key);
    unique.push(cue);
  }
  if (unique.length > LIVE2D_LIMITS.maxKept) degraded.push('live2d.too-many');
  return { face, live2d: unique.slice(0, LIVE2D_LIMITS.maxKept), degraded };
}

/**
 * 归一化一次判读的原始对象。
 *
 * 整轮只有「一个可用字段都没有」才失败；其余情况一律降级返回，
 * 由调用方决定是否落账（层 1 只在成功时落账）。
 *
 * @param {object} data 模型返回并已解析为对象的数据。
 * @param {{utterance?: string}} [context] 归一化上下文。
 * @returns {{ok: boolean, result?: object, degraded: string[], code?: string}} 结果。
 */
export function normalizeJudgeResult(data, context = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, code: JUDGE_ERRORS.NOT_OBJECT, degraded: [] };
  }
  const utterance = context.utterance || '';
  const degraded = [];

  const { delta, degraded: dDelta } = normalizeDelta(data.delta);
  const { beats, degraded: dBeats } = normalizeBeats(data.beats, utterance);
  const { feelings, emo, feelLinks, degraded: dFeel } = normalizeFeelings(data.feelings, data.emo);
  const { event: rawEvent, degraded: dEvent } = normalizeEvent(data.event);
  // 摘句必须能在这一轮原话里逐字找到；原话为空时 quote 一律清空，
  // 否则「空原话 + 模型编一句摘句」就能撑起「认一句 / 划界退开」（P0-6）。
  const event = { ...rawEvent };
  if (event.quote) {
    if (!utterance) {
      event.quote = '';
      dEvent.push('event.quote.no-utterance');
    } else if (!utterance.includes(event.quote)) {
      event.quote = '';
      dEvent.push('event.quote.missing');
    }
  }
  const { act: rawAct, degraded: dAct } = normalizeAct(data.act);
  const { act, degraded: dResolve } = resolveAct(rawAct, event, utterance);
  const { signal, degraded: dSignal } = normalizeSignals(data);
  if (signal.mask?.q) {
    if (!utterance) {
      signal.mask.q = '';
      dSignal.push('mask.quote.no-utterance');
    } else if (!utterance.includes(signal.mask.q)) {
      signal.mask.q = '';
      dSignal.push('mask.quote.missing');
    }
  }
  const { burst, degraded: dBurst } = normalizeBurst(data.burst);
  const { bond, degraded: dBond } = normalizeBond(data.bond);
  const { text: read, degraded: dRead } = normalizeRead(data.read);
  const { text: monologue, degraded: dMonologue } = normalizeMonologue(data.monologue);
  const live2dSource = data.live2d != null
    ? (Array.isArray(data.live2d) && data.face ? { face: data.face, cues: data.live2d } : data.live2d)
    : { face: data.face, cues: data.cues };
  const { face, live2d, degraded: dLive2d } = normalizeLive2d(live2dSource);
  const legacyProseIgnored = ['mood', 'state', 'body', 'why']
    .some((key) => Boolean(cleanText(data[key], { max: key === 'state' ? 1600 : 240 })));
  if (legacyProseIgnored) degraded.push('legacy-prose.ignored');

  degraded.push(
    ...dDelta,
    ...dBeats,
    ...dFeel,
    ...dEvent,
    ...dAct,
    ...dResolve,
    ...dSignal,
    ...dBurst,
    ...dBond,
    ...dRead,
    ...dMonologue,
    ...dLive2d
  );

  let carry = cleanText(data.carry, { max: 4 });
  if (!CARRY_VALUES.includes(carry)) {
    if (carry) degraded.push('carry.illegal');
    carry = '';
  }

  const optional = {
    let_go: cleanText(data.let_go, { max: TEXT_LIMITS.let_go, stripDigit: true }),
    read,
    monologue,
    why: '',
    body: '',
  };
  const judgeNote = cleanText(data.judge, { max: TEXT_LIMITS.judge, stripDigit: true });
  if (judgeNote && /(信任|黏人|分数|数值|轴)/.test(judgeNote)) {
    degraded.push('judge.bad-word');
    optional.judge = '';
  } else if (judgeNote) {
    optional.judge = judgeNote;
  }

  const result = {
    delta,
    feelings,
    emo,
    mood: '',
    state: '',
    act,
    event,
    carry,
    ...optional,
    ...signal,
    burst,
    beats,
    bond,
    feelLinks,
    face,
    live2d,
    degraded: [...new Set(degraded)].sort(),
  };

  // 「可用字段」只认观察员真正给出的结构化信号。旧版预写散文即使模型
  // 违规返回也不参与落账资格，否则一段散文就能在没有观察时伪造一整轮。
  const usable =
    Object.keys(delta).length > 0 ||
    Object.keys(burst).length > 0 ||
    feelings.length > 0 ||
    (Boolean(emo) && emo !== '空') ||
    beats.length > 0 ||
    Boolean(event.what) ||
    Boolean(event.quote) ||
    Boolean(rawAct) ||
    Boolean(signal.mask || signal.surge || signal.sting) ||
    (
      Number(signal.ep?.i || 0) > 0
      && signal.ep.state !== '没问'
    ) ||
    Boolean(result.let_go) ||
    Boolean(result.judge) ||
    Math.abs(bond) > 0 ||
    Boolean(face) ||
    live2d.length > 0;
  if (!usable) return { ok: false, code: JUDGE_ERRORS.ALL_FIELDS_BAD, degraded: result.degraded };

  return { ok: true, result, degraded: result.degraded };
}

/**
 * `burst` / `bond` 限幅（契约 §5），供层 2 应用状态时复用。
 *
 * @param {unknown} rawBurst 原始 burst 对象。
 * @returns {{burst: Record<string, number>, degraded: string[]}} 结果。
 */
export function normalizeBurst(rawBurst) {
  const burst = {};
  const degraded = [];
  if (!rawBurst || typeof rawBurst !== 'object' || Array.isArray(rawBurst)) {
    return { burst, degraded };
  }
  for (const key of DELTA_KEYS) {
    if (!(key in rawBurst)) continue;
    const n = finiteNumber(rawBurst[key]);
    if (n === null) {
      degraded.push(`burst.${key}.not-finite`);
      continue;
    }
    // 低于下限的绝对值不是「小情绪」，是「没有这一拍」：直接丢弃，不留成 0 或残值
    // （R1 派工单 P1-3；契约 §5 的 burst 区间是 45..85）。
    if (Math.abs(n) < BURST_LIMITS.min) {
      degraded.push(`burst.${key}.too-small`);
      continue;
    }
    burst[key] = Math.sign(n) * Math.round(Math.min(BURST_LIMITS.max, Math.abs(n)));
  }
  return { burst, degraded };
}

/**
 * `bond` 限幅。
 *
 * @param {unknown} raw 原始 bond。
 * @returns {{bond: number, degraded: string[]}} 结果。
 */
export function normalizeBond(raw) {
  const n = finiteNumber(raw);
  if (n === null) return { bond: 0, degraded: [] };
  const clamped = Math.max(BOND_LIMITS.min, Math.min(BOND_LIMITS.max, Math.round(n)));
  return { bond: clamped, degraded: clamped === Math.round(n) ? [] : ['bond.clamped'] };
}
