/**
 * 纯归约逻辑：Session 事件 → 桌宠状态 + 通知效果。
 *
 * 这个模块**不 require 任何 DSH 包**，可以被 `node --test` 直接跑，
 * 也是「快照基线不重播历史通知」（派工单 P0-2 / 三节）的唯一实现点。
 *
 * 状态形状：
 *   { sessionId, phase, turn, tool, approval, lastSeq, lastReason, notified:Set }
 *
 * ⚠️ `notify` 效果只在**实时事件**上产生；`reduceSnapshot()` 永远返回空 effects。
 */

export const PHASES = Object.freeze([
  'offline',
  'unbound',
  'idle',
  'thinking',
  'streaming',
  'tool',
  'waiting_approval',
  'completed',
  'error',
]);

/** 这些收尾原因属于「被中断」，不是失败。 */
const IDLE_REASONS = new Set(['aborted', 'interrupted', 'forked']);

export function createState(sessionId = null) {
  return {
    sessionId: sessionId ?? null,
    phase: sessionId ? 'idle' : 'unbound',
    turn: null,
    tool: null,
    approval: null,
    lastSeq: -1,
    lastReason: null,
    notified: new Set(),
  };
}

/** 把 turn/end 的 reason 归一成一个短字符串。 */
export function reasonKind(reason) {
  if (!reason || typeof reason !== 'object') return 'unknown';
  return typeof reason.kind === 'string' ? reason.kind : 'unknown';
}

/** 通知去重键。完成/失败按轮次，审批按审批 id。 */
export function notifyKey(kind, { sessionId, turn, reasonKind: rk, id } = {}) {
  if (kind === 'approval') return `approval:${sessionId ?? ''}:${id ?? '?'}`;
  return `turn:${sessionId ?? ''}:${turn ?? '?'}:${rk ?? kind}`;
}

function withState(state, patch) {
  return { ...state, ...patch, notified: state.notified };
}

function pushNotify(effects, state, kind, extra = {}) {
  const key = notifyKey(kind, { sessionId: state.sessionId, ...extra });
  if (state.notified.has(key)) return;
  state.notified.add(key);
  const effect = {
    kind: 'notify',
    notifyKind: kind,
    key,
    turn: extra.turn ?? null,
    detail: extra.detail ?? '',
  };
  if (kind === 'approval' && extra.id != null) effect.id = String(extra.id);
  effects.push(effect);
}

/**
 * 应用一条实时持久事件。
 * @returns {{state: object, effects: Array}}
 */
export function applyEvent(state, event) {
  const effects = [];
  if (!event || typeof event !== 'object') return { state, effects };
  const seq = Number(event.seq);
  if (Number.isFinite(seq) && seq <= state.lastSeq) return { state, effects };
  const next = withState(state, Number.isFinite(seq) ? { lastSeq: seq } : {});
  const data = event.data && typeof event.data === 'object' ? event.data : {};

  switch (event.type) {
    case 'turn/start': {
      next.phase = 'thinking';
      const turnNo = Number(data.turn);
      if (Number.isFinite(turnNo)) next.turn = turnNo;
      next.tool = null;
      next.lastReason = null;
      break;
    }
    case 'step/start': {
      if (next.phase === 'completed' || next.phase === 'error' || next.phase === 'idle') {
        next.phase = 'thinking';
      }
      break;
    }
    case 'tool/call': {
      next.phase = 'tool';
      next.tool = {
        name: typeof data.name === 'string' ? data.name : 'tool',
        callId: typeof data.callId === 'string' ? data.callId : null,
      };
      break;
    }
    case 'tool/result': {
      next.phase = 'thinking';
      next.tool = null;
      break;
    }
    case 'approval/asked': {
      next.phase = 'waiting_approval';
      next.approval = {
        id: typeof data.id === 'string' ? data.id : null,
        toolName: typeof data.toolName === 'string' ? data.toolName : 'tool',
      };
      pushNotify(effects, next, 'approval', {
        id: next.approval.id,
        detail: next.approval.toolName,
      });
      break;
    }
    case 'approval/decided': {
      if (!next.approval || next.approval.id === data.id || data.id == null) {
        next.approval = null;
        if (next.phase === 'waiting_approval') next.phase = 'thinking';
      }
      break;
    }
    case 'turn/end': {
      const rk = reasonKind(data.reason);
      next.lastReason = rk;
      next.tool = null;
      next.approval = null;
      if (rk === 'completed') {
        next.phase = 'completed';
        pushNotify(effects, next, 'completed', { turn: data.turn, reasonKind: rk, detail: '完成' });
      } else if (rk === 'max-tokens') {
        // 不算完整成功：状态仍是 completed，但显式给出 truncated 效果。
        next.phase = 'completed';
        effects.push({ kind: 'truncated', turn: data.turn ?? null });
        pushNotify(effects, next, 'completed', {
          turn: data.turn,
          reasonKind: rk,
          detail: '输出被截断',
        });
      } else if (rk === 'error' || rk === 'blocked') {
        next.phase = 'error';
        const message = data.reason && data.reason.error && data.reason.error.message;
        pushNotify(effects, next, 'error', {
          turn: data.turn,
          reasonKind: rk,
          detail: typeof message === 'string' ? message.slice(0, 200) : rk,
        });
      } else if (IDLE_REASONS.has(rk)) {
        next.phase = 'idle';
      } else {
        next.phase = 'idle';
      }
      break;
    }
    case 'assistant/message': {
      if (next.phase === 'completed' || next.phase === 'error') break;
      next.phase = 'thinking';
      break;
    }
    default:
      break;
  }
  return { state: next, effects };
}

/** 临时流到达时把状态推到 streaming（不影响持久游标）。 */
export function applyDelta(state, frame) {
  if (!frame || typeof frame !== 'object') return state;
  if (frame.type === 'start') {
    if (state.phase === 'completed' || state.phase === 'error') {
      return { ...state, phase: 'streaming' };
    }
    return { ...state, phase: 'streaming' };
  }
  if (frame.type === 'end') {
    // abandoned 不代表任务结束，也不改变 phase。
    return state;
  }
  return state;
}

/**
 * 反扫快照，重建「当前状态」。
 *
 * 只恢复三样：最近一个未结束的 turn、仍 asked 未 decided 的审批、最后一轮的收尾原因。
 * 历史里的完成/失败/审批结果**一律不产生 notify**。
 *
 * @param {Array} records 快照里的记录（`{type:'event', event:{type,seq,data}}` 或裸事件）
 * @param {number} cursor 快照游标
 */
export function reduceSnapshot(records, cursor, sessionId = null) {
  const events = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!record) continue;
    const event = record.type === 'event' && record.event ? record.event : record;
    if (event && typeof event.type === 'string') events.push(event);
  }
  events.sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));

  const openTurns = new Set();
  const asked = new Map();
  let lastTurn = null;
  let lastTool = null;
  let lastSeq = Number.isFinite(Number(cursor)) ? Number(cursor) : -1;

  for (const event of events) {
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    const seq = Number(event.seq);
    if (Number.isFinite(seq)) lastSeq = Math.max(lastSeq, seq);
    switch (event.type) {
      case 'turn/start': {
        openTurns.add(data.turn);
        lastTurn = data.turn;
        break;
      }
      case 'turn/end': {
        openTurns.delete(data.turn);
        break;
      }
      case 'tool/call': {
        lastTool = { name: data.name ?? 'tool', callId: data.callId ?? null };
        break;
      }
      case 'tool/result': {
        lastTool = null;
        break;
      }
      case 'approval/asked': {
        asked.set(data.id, { id: data.id, toolName: data.toolName ?? 'tool' });
        break;
      }
      case 'approval/decided': {
        asked.delete(data.id);
        break;
      }
      default:
        break;
    }
  }

  const pending = asked.size > 0 ? [...asked.values()][asked.size - 1] : null;
  const turnOpen = openTurns.size > 0 ? [...openTurns][openTurns.size - 1] : null;

  let phase;
  if (pending) phase = 'waiting_approval';
  else if (turnOpen !== null) phase = lastTool ? 'tool' : 'thinking';
  else phase = 'idle';

  return {
    state: {
      sessionId: sessionId ?? null,
      phase,
      turn: turnOpen !== null ? turnOpen : lastTurn,
      tool: phase === 'tool' ? lastTool : null,
      approval: pending,
      lastSeq,
      lastReason: null,
      notified: new Set(),
    },
    effects: [],
  };
}

const TEXT_CAP = 4000;
const REASONING_CAP = 6000;

function blocksOfType(message, type) {
  if (!message || typeof message !== 'object') return '';
  const content = Array.isArray(message.content) ? message.content : [];
  const parts = [];
  for (const block of content) {
    if (block && block.type === type && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

function textOf(message) {
  const text = blocksOfType(message, 'text');
  return text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) : text;
}

/**
 * 把模型偶尔写出的舞台动作收回到即时聊天口吻。
 *
 * 只处理完整括号或星号里的动作解说，避免误伤正常句中括号。亲吻、拥抱和
 * 蹭蹭改成口语拟声词，其余动作旁白直接拿掉。partial=true 时还会藏住正在
 * 流式输入、尚未闭合的动作括号，防止半截旁白先闪出来。
 */
export function humanizeAssistantVoice(value, options = {}) {
  let text = typeof value === 'string' ? value : '';
  if (!text) return '';
  const partial = options && options.partial === true;

  const isActionNarration = (raw) => {
    const compact = String(raw || '')
      .trim()
      .replace(/^[，,、；;：:\s]+|[，,、；;：:\s]+$/g, '')
      .replace(/\s+/g, '');
    if (!compact) return true;
    const lead = /^(?:(?:又|先|再|轻轻|悄悄|飞快地|忍不住|突然|慢慢|乖乖|有点|小声|低声|得意地|心虚地|不好意思地|脸红地|迟疑地)[，,、\s]*)*/;
    const actionBody = /^(?:凑(?:近|过去|过来|上来|到)|亲(?:亲|了|着|一下|一口|住)|吻(?:了|着|一下|住)|mua|啵(?:啵|了|一下)|抱(?:抱|住|紧|了|着|一下)|搂(?:住|着|了|一下)|蹭(?:蹭|了|着|一下)|摸(?:摸|了|着|一下)|低(?:下|着)?头|抬(?:起|着)?头|歪(?:着|了)?头|点(?:了|着)?头|摇(?:了|着)?头|眨(?:了|着)?眼|坏笑|偷笑|轻笑|笑(?:笑|了|着|一下|一声|出声)|哭(?:了|着|出声)|看(?:着|了(?:一眼|一下)?|向|过来|过去)|盯(?:着|了)|瞥(?:了|着|一眼)|望(?:着|了|向)|退开|后退|靠近|转身|牵(?:住|着|手|了)|拉(?:住|着|过|了)|捏(?:了|着|一下)|戳(?:了|着|一下)|拍(?:拍|了|着|一下)|叹气|皱眉|脸红|咬唇|愣(?:了)?|呆(?:住|了)?|喘(?:了|着|口气)|哼(?:了|一声|着)|嘟囔(?:着|了)?|沉默|停顿|伸手|说(?:着|道|了一句|了一声)|抓(?:住|着|了)?|拿(?:起|着|了)?|放(?:下|在|着|了)|坐(?:下|着|回)|站(?:起|着)|走(?:进|出|向|过去|过来|了|着)|挥(?:手|了|着)?|招(?:手|了|着)?|敲(?:了|着|门|一下)|弹(?:了|着|一下))/i;
    const exactStage = /^(?:笑|哭|闹|哼|愣|呆|沉默|停顿|叹气|皱眉|脸红|咬唇|眨眼|点头|摇头|低头|抬头|歪头|吻|亲|抱|搂|蹭|摸|盯|瞥|望|牵|拉|捏|戳|拍|挥|招|敲|弹|说|看)$/;
    if (exactStage.test(compact)) return true;
    const rest = compact.replace(lead, '');
    if (actionBody.test(rest)) return true;
    const hasSubject = /^(?:她|他|我|主人|对方)/.test(compact);
    if (!hasSubject) return false;
    const afterSubject = compact
      .replace(/^(?:她|他|我|主人|对方)/, '')
      .replace(lead, '');
    return actionBody.test(afterSubject);
  };

  const spokenReplacement = (raw) => {
    const compact = String(raw || '').replace(/\s+/g, '');
    if (/(?:亲|吻|mua|啵)/i.test(compact)) return 'mua~ ';
    if (/蹭/.test(compact) && !/(?:抱|搂)/.test(compact)) return '蹭蹭~ ';
    if (/(?:抱|搂)/.test(compact)) return '抱~ ';
    return '';
  };

  const replaceStage = (whole, inner) => {
    if (!isActionNarration(inner)) return whole;
    return spokenReplacement(inner);
  };

  text = text.replace(/[（(]([^（）()\n]{1,180})[）)]/g, replaceStage);
  text = text.replace(/(?<!\*)\*([^*\n]{1,180})\*(?!\*)/g, replaceStage);

  const open = Math.max(text.lastIndexOf('（'), text.lastIndexOf('('));
  const close = Math.max(text.lastIndexOf('）'), text.lastIndexOf(')'));
  if (open > close) {
    const unfinished = text.slice(open + 1);
    if ((partial && !unfinished.trim()) || isActionNarration(unfinished)) text = text.slice(0, open);
  }
  const stars = [...text.matchAll(/\*/g)];
  if (stars.length % 2 === 1) {
    const starOpen = stars[stars.length - 1].index;
    const unfinished = text.slice(starOpen + 1);
    if ((partial && !unfinished.trim()) || isActionNarration(unfinished)) text = text.slice(0, starOpen);
  }

  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+([，。！？；：、,.!?;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[，,、；;：:\s]+/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function assistantTextOf(message) {
  const text = humanizeAssistantVoice(blocksOfType(message, 'text'));
  return text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) : text;
}

/**
 * DSH 的持久 assistant/message 会把 reasoning 作为独立 content block 保存。
 * 这里只做本地展示裁剪，不写日志、不广播到桥外。
 */
function reasoningOf(message) {
  if (!message || typeof message !== 'object') return '';
  const fromBlocks = blocksOfType(message, 'reasoning');
  const direct = typeof message.reasoning === 'string' ? message.reasoning : '';
  const text = fromBlocks || direct;
  return text.length > REASONING_CAP ? text.slice(0, REASONING_CAP) : text;
}

/**
 * DSH 会把运行环境、时间、记忆等内部材料持久化成 role=user 的事件。
 * 只有来源确实是用户本人的消息，才能进入陪伴聊天的“我”气泡和实时事件流。
 */
export function isHumanUserMessage(event) {
  if (!event || event.type !== 'user/message') return false;
  const sourceKind = String(event.data?.source?.kind ?? '');
  return sourceKind === '' || sourceKind === 'user';
}

/**
 * 裁剪要发给桌宠的事件载荷：去掉工具参数、工具结果正文、assistant 流记录。
 * 工具参数与结果仍然不离开 DSH；assistant 的正文与思考只留本地展示所需的一份裁剪副本。
 * 内部注入的 user/message 不是聊天正文，返回 null，由桥接层直接跳过广播。
 */
export function trimEvent(event, options = {}) {
  const type = String(event?.type ?? 'unknown');
  const seq = Number(event?.seq);
  const time = Number(event?.time);
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const includeReasoning = options.includeReasoning !== false;
  if (type === 'user/message' && !isHumanUserMessage(event)) return null;
  let out;
  switch (type) {
    case 'turn/start':
      out = { turn: data.turn ?? null };
      break;
    case 'turn/end': {
      const reason = { kind: reasonKind(data.reason) };
      const error = data.reason && data.reason.error;
      if (error && typeof error === 'object') {
        if (typeof error.code === 'string' && error.code) {
          reason.code = error.code.slice(0, 80);
        }
        if (typeof error.message === 'string' && error.message.trim()) {
          reason.message = error.message.trim().slice(0, 300);
        }
      }
      out = { turn: data.turn ?? null, reason };
      break;
    }
    case 'step/start':
    case 'step/end':
      out = { turn: data.turn ?? null, step: data.step ?? null };
      break;
    case 'tool/call':
      out = { turn: data.turn ?? null, callId: data.callId ?? null, name: data.name ?? 'tool' };
      break;
    case 'tool/result':
      out = {
        turn: data.turn ?? null,
        callId: data.message?.toolCallId ?? null,
        ok: !data.error && data.message?.isError !== true,
      };
      break;
    case 'approval/asked':
      out = { id: data.id ?? null, toolName: data.toolName ?? 'tool' };
      break;
    case 'approval/decided':
      out = { id: data.id ?? null, outcome: data.outcome ?? null };
      break;
    case 'assistant/message': {
      out = { turn: data.turn ?? null, step: data.step ?? null, text: assistantTextOf(data.message) };
      if (includeReasoning) {
        const reasoning = reasoningOf(data.message);
        if (reasoning) out.reasoning = reasoning;
      }
      break;
    }
    case 'user/message': {
      const text = textOf(data);
      out = { text: text.length > 2000 ? text.slice(0, 2000) : text };
      break;
    }
    default:
      out = {};
      break;
  }
  return {
    type,
    seq: Number.isFinite(seq) ? seq : null,
    time: Number.isFinite(time) ? time : null,
    data: out,
  };
}

/**
 * 从 follow 快照的记录里投影最近的人话对话，供重连和首次打开时铺底。
 * 只收真实用户输入与 assistant 最终消息；runtime context、工具回显等不混进来。
 */
export function projectTranscript(records, limit = 24, options = {}) {
  const includeReasoning = options.includeReasoning !== false;
  const events = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!record) continue;
    const event = record.type === 'event' && record.event ? record.event : record;
    if (event && typeof event.type === 'string') events.push(event);
  }
  events.sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));

  const out = [];
  for (const event of events) {
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    const seq = Number.isFinite(Number(event.seq)) ? Number(event.seq) : null;
    const time = Number.isFinite(Number(event.time)) ? Number(event.time) : null;
    if (event.type === 'user/message') {
      if (!isHumanUserMessage(event)) continue;
      const text = textOf(data);
      if (!text.trim()) continue;
      out.push({ role: 'user', seq, time, text });
    } else if (event.type === 'assistant/message') {
      const text = assistantTextOf(data.message);
      const reasoning = includeReasoning ? reasoningOf(data.message) : '';
      if (!text.trim() && !reasoning.trim()) continue;
      const item = {
        role: 'assistant',
        seq,
        time,
        turn: data.turn ?? null,
        step: data.step ?? null,
        text,
      };
      if (reasoning) item.reasoning = reasoning;
      out.push(item);
    }
  }
  const max = Math.max(1, Math.min(100, Math.floor(Number(limit) || 24)));
  return out.length > max ? out.slice(out.length - max) : out;
}

/** 从 assistant-stream 帧里抽出可显示的增量文本。 */
export function deltaText(frame, options = {}) {
  if (!frame || frame.type !== 'chunk') return null;
  const chunk = frame.chunk && typeof frame.chunk === 'object' ? frame.chunk : null;
  if (!chunk || typeof chunk.text !== 'string' || chunk.text === '') return null;
  if (chunk.type === 'text-delta') {
    return { index: frame.index ?? 0, text: chunk.text, kind: 'text' };
  }
  if (chunk.type === 'reasoning-delta') {
    if (options.includeReasoning === false) return null;
    return { index: frame.index ?? 0, text: chunk.text, kind: 'reasoning' };
  }
  return null;
}
