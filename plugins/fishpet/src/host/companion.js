/**
 * DSH 陪伴会话与情绪系统的协调器。
 *
 * 这一层只负责把真实发生的事件接起来：
 * `agent/pre-step` 中的真实用户消息 -> 判读与上下文注入；
 * 持久 `user/message` -> 稳定 eventId 与 turn 关联；
 * `assistant/message` / `turn/end` -> 把真实回复补回同一轮看板记录；
 * 判读结果中的 Live2D cue -> 一条可去重的表现帧。
 *
 * 不创建会话、不拼假回复、不依赖标题关键词。所有外部副作用都通过注入的
 * `emotion` 与 `publish` 完成，便于用 fake 驱动完整回归。
 *
 * @module dsh-fishpet-emotion/host/companion
 */

import { createHash } from 'node:crypto';

import { humanizeAssistantVoice } from '../bridge/lib/reduce.js';
import { activityContextText } from './activity-context.js';

export const COMPANION_CHANNEL = 'chat';
export const COMPANION_CONTEXT_HEADER =
  '【FishPet 情绪上下文 · 不是用户的新发言】\n'
  + '这些是程序整理的她此刻状态与观察信号；结合主人原话和最近对话理解，不要逐项复述。';
/**
 * 情绪账里的关系身份不能跟着会话 id 走。否则每换一次人设修订，都会像
 * 第一次认识主人一样从默认好感重新开始。这个键只存在于本机私有状态，
 * 不写入提示词，也不携带用户名或平台账号。
 */
export const COMPANION_RELATIONSHIP_REF = 'dsh:companion-owner';

const MAX_RECENT = 6;
const MAX_RECORDS = 240;
const MAX_SEEN_CUES = 500;

function textOfMessage(message) {
  if (!message || typeof message !== 'object') return '';
  const content = Array.isArray(message.content) ? message.content : [];
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return humanizeAssistantVoice(parts.join('').trim());
}

function sourceKeyOf(message) {
  if (!message || typeof message !== 'object') return '';
  const source = message.source && typeof message.source === 'object'
    ? message.source
    : {};
  if (source.kind !== 'user') return '';
  if (typeof source.rpcId === 'string' && source.rpcId.trim()) {
    return `rpc:${source.rpcId.trim()}`;
  }
  if (typeof message.id === 'string' && message.id.trim()) {
    return `message:${message.id.trim()}`;
  }
  return '';
}

function isMnemonRoutingInstruction(message) {
  if (!message || typeof message !== 'object') return false;
  const source = message.source && typeof message.source === 'object'
    ? message.source
    : {};
  if (source.kind !== 'plugin') return false;
  const plugin = typeof source.plugin === 'string' ? source.plugin.toLowerCase() : '';
  if (!plugin.includes('mnemon')) return false;
  const text = textOfMessage(message);
  return text.startsWith('[MNEMON]');
}

function isMnemonRuntimeMemory(message) {
  if (!message || typeof message !== 'object') return false;
  const source = message.source && typeof message.source === 'object'
    ? message.source
    : {};
  if (source.kind !== 'plugin' || typeof source.plugin !== 'string') return false;
  return source.plugin.toLowerCase().includes('mnemon')
    && textOfMessage(message).startsWith('MNEMON RUNTIME MEMORY SNAPSHOT');
}

/**
 * Working references are project notes, not memories of a shared life.
 *
 * Mnemon deliberately combines the owner profile with a larger project
 * reference file. That is useful in a coding session, but in a private chat it
 * turns every casual greeting into a work briefing. Keep the owner profile and
 * remove only file blocks explicitly labelled as working references.
 */
export function withoutCompanionWorkingReference(message) {
  if (!isMnemonRuntimeMemory(message)) return message;
  const content = Array.isArray(message.content) ? message.content : [];
  let changed = false;
  const nextContent = content.map((block) => {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') return block;
    const text = block.text.replace(
      /\n[^\n]*\(working reference\)\s*\n<runtime-memory-file\b[^>]*>[\s\S]*?<\/runtime-memory-file>/giu,
      '',
    );
    if (text === block.text) return block;
    changed = true;
    return { ...block, text };
  });
  return changed ? { ...message, content: nextContent } : message;
}

/**
 * Remove Mnemon's workbench guidance from a companion turn.
 *
 * The owner profile and ordinary memory files stay available: remembering the
 * owner is part of living together. Project working references and the
 * `[MNEMON]` reminder belong to coding work and make a casual chat read like an
 * agent task. DSH applies tool restrictions after Mnemon's pre-step hook, so
 * these messages must be cleaned in the final decision rather than from the
 * tool list alone.
 */
export function withoutCompanionWorkGuidance(decision) {
  if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) {
    return decision;
  }
  const messages = [];
  for (const message of decision.messages) {
    if (isMnemonRoutingInstruction(message)) continue;
    messages.push(withoutCompanionWorkingReference(message));
  }
  return messages.length === decision.messages.length
    && messages.every((message, index) => message === decision.messages[index])
    ? decision
    : { ...decision, messages };
}

/**
 * 稳定 eventId：只使用会话与请求/消息身份，不含正文，重启后仍得到同一个值。
 *
 * @param {string} sessionId DSH 会话 id。
 * @param {string} sourceKey `rpc:<id>` 或 `message:<id>`。
 * @returns {string}
 */
export function companionEventId(sessionId, sourceKey) {
  const digest = createHash('sha256')
    .update(String(sessionId || ''), 'utf8')
    .update('\0', 'utf8')
    .update(String(sourceKey || ''), 'utf8')
    .digest('hex')
    .slice(0, 40);
  return `fishpet:chat:${digest}`;
}

function normalizeContext(outcome) {
  const blocks = Array.isArray(outcome?.context) ? outcome.context : [];
  const unique = [];
  const seen = new Set();
  for (const raw of blocks) {
    const text = String(raw || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    unique.push(text);
  }
  if (!unique.length) return '';
  return `${COMPANION_CONTEXT_HEADER}\n${unique.join('\n')}`;
}

function cueSummary(result) {
  if (!result || typeof result !== 'object') return '';
  const feelings = Array.isArray(result.feelings)
    ? result.feelings.filter((word) => typeof word === 'string' && word.trim()).slice(0, 3)
    : [];
  return feelings.length
    ? feelings.join('、')
    : String(result.emo || result.mood || '').slice(0, 60);
}

function cueFromOutcome(outcome, identity, now) {
  const result = outcome?.result;
  if (!result || typeof result !== 'object') return null;
  const live2d = Array.isArray(result.live2d) ? result.live2d.slice(0, 4) : [];
  const face = typeof result.face === 'string' ? result.face : '';
  if (!face && !live2d.length) return null;
  return {
    eventId: identity.eventId,
    sessionId: identity.sessionId,
    turn: Number(identity.turn) || 0,
    at: now,
    seq: identity.eventId,
    face,
    live2d,
    summary: cueSummary(result),
  };
}

function replyText(event) {
  const message = event?.data?.message;
  if (!message || typeof message !== 'object') return '';
  const content = Array.isArray(message.content) ? message.content : [];
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('').trim();
}

function eventOfRecord(record) {
  return record?.type === 'event' && record.event ? record.event : record;
}

function roundKey(sessionId, turn) {
  return `${sessionId}\0${Number(turn)}`;
}

function modelFromEvent(event) {
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const config = data.header?.config && typeof data.header.config === 'object'
    ? data.header.config
    : {};
  const provider = String(data.provider || config.provider || '').trim();
  const model = String(data.model || config.model || '').trim();
  return provider || model ? { provider, model } : null;
}

function usagePart(event, identity) {
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  if (!data.usage || typeof data.usage !== 'object' || Array.isArray(data.usage)) return null;
  const step = String(event?.seq ?? data.step ?? data.message?.id ?? '');
  return {
    step,
    provider: String(identity?.provider || ''),
    model: String(identity?.model || ''),
    usage: {
      ...data.usage,
      calls: Math.max(1, Number(data.usage.calls) || 1),
    },
    at: Number.isFinite(Number(event?.time)) ? Number(event.time) : null,
  };
}

/**
 * 创建陪伴轮次协调器。
 *
 * @param {object} options
 * @param {object} options.emotion `fishpetEmotion` API（judge / observeReply）。
 * @param {(error: Error, code: string) => void} [options.log] 脱敏日志。
 * @param {() => number} [options.clock] 毫秒时钟。
 * @param {(line: string) => void} [options.onCue] 发布 Live2D 帧。
 * @param {() => boolean} [options.canInjectContext] systemPrompt 上下文是否可用。
 * @param {(input: {judge: object[], reply: object[], at: number}) => Promise<object|null>} [options.estimateRoundCosts]
 *   Estimate the two model roles for one completed turn.
 * @returns {object} 协调器。
 */
export function createCompanionCoordinator({
  emotion,
  log = () => {},
  clock = () => Date.now(),
  onCue = () => {},
  canInjectContext = () => true,
  estimateRoundCosts = null,
}) {
  /** `${sessionId}\0${sourceKey}` -> 判读轮次 */
  const recordsBySource = new Map();
  /** `${sessionId}\0${turn}` -> 该轮 eventId 集合 */
  const rounds = new Map();
  /** eventId -> 最近一次成功判读 outcome（同一步重试时复用上下文） */
  const outcomes = new Map();
  /** sessionId -> 最近几句真实对话 */
  const recent = new Map();
  /** sessionId -> 当前打开/最近一轮 turn */
  const currentTurns = new Map();
  /** sessionId -> 最近一份情绪表现帧（重连快照用） */
  const latestCues = new Map();
  /** sessionId -> 注入 systemPrompt.context 的动态情绪文本 */
  const conversationContexts = new Map();
  /** sessionId -> 最近一次由 FishPet 携带的前台软件短快照 */
  const activityContexts = new Map();
  /** sessionId -> 下一次主动陪伴回合的一次性内部上下文 */
  const proactiveContexts = new Map();
  /** sessionId -> 等待 systemPrompt.context 真正读取后确认的陪伴时钟提醒 */
  const pendingPresenceAcks = new Map();
  /** eventId -> 是否已成功通过观察补写过回复 */
  const observed = new Set();
  /** eventId -> 正在调用 observeReply，避免同一轮并发重复写入 */
  const observing = new Set();
  /** `${sessionId}\0${turn}` -> assistant 正文 */
  const replies = new Map();
  /** `${sessionId}\0${turn}` -> provider/model used by reply steps */
  const turnModels = new Map();
  /** sessionId -> most recently observed provider/model */
  const sessionModels = new Map();
  /** `${sessionId}\0${turn}` -> Map(step identity -> model usage) */
  const replyUsage = new Map();
  let closed = false;

  function report(code, error) {
    try {
      log(error, code);
    } catch {
      /* 日志失败不影响陪伴回复 */
    }
  }

  function rememberRecent(sessionId, role, text) {
    const value = String(text || '').trim();
    if (!value) return;
    const list = recent.get(sessionId) || [];
    const item = { role, text: value.slice(0, 600) };
    // DSH can emit several assistant steps for one turn around a tool call. The
    // earlier step is not a separate thing she said to the owner; keep only the
    // latest step so the next turn does not learn her duplicated draft as chat
    // history.
    if (role === 'assistant' && list.at(-1)?.role === 'assistant') {
      list[list.length - 1] = item;
    } else {
      list.push(item);
    }
    if (list.length > MAX_RECENT) list.splice(0, list.length - MAX_RECENT);
    recent.set(sessionId, list);
  }

  function trimMaps() {
    while (recordsBySource.size > MAX_RECORDS) {
      recordsBySource.delete(recordsBySource.keys().next().value);
    }
    while (rounds.size > MAX_RECORDS) {
      rounds.delete(rounds.keys().next().value);
    }
    while (turnModels.size > MAX_RECORDS) {
      turnModels.delete(turnModels.keys().next().value);
    }
    while (replyUsage.size > MAX_RECORDS) {
      replyUsage.delete(replyUsage.keys().next().value);
    }
    while (observed.size > MAX_SEEN_CUES) {
      observed.delete(observed.values().next().value);
    }
  }

  function addRoundEvent(sessionId, turn, eventId) {
    if (!eventId || turn == null || !Number.isFinite(Number(turn))) return;
    const key = roundKey(sessionId, turn);
    const set = rounds.get(key) || new Set();
    set.add(eventId);
    rounds.set(key, set);
  }

  function observeModelEvent(sessionId, event) {
    const identity = modelFromEvent(event);
    if (identity) {
      sessionModels.set(sessionId, identity);
      const turn = currentTurns.get(sessionId);
      if (turn != null) turnModels.set(roundKey(sessionId, turn), identity);
    }
    const turn = currentTurns.get(sessionId);
    return turn == null
      ? sessionModels.get(sessionId) || null
      : turnModels.get(roundKey(sessionId, turn))
        || sessionModels.get(sessionId)
        || null;
  }

  function rememberReplyUsage(sessionId, turn, event, identity) {
    if (turn == null) return;
    const part = usagePart(event, identity);
    if (!part) return;
    const key = roundKey(sessionId, turn);
    const steps = replyUsage.get(key) || new Map();
    const stepKey = part.step || `${event?.time || clock()}-${steps.size}`;
    steps.set(stepKey, part);
    replyUsage.set(key, steps);
  }

  function judgeUsageFor(eventIds) {
    const parts = [];
    for (const eventId of eventIds) {
      const outcome = outcomes.get(eventId);
      if (!outcome || !outcome.usage || typeof outcome.usage !== 'object') continue;
      parts.push({
        provider: String(outcome.llm?.provider || ''),
        model: String(outcome.llm?.model || ''),
        usage: outcome.usage,
        at: Number(outcome.llm?.at) || null,
      });
    }
    return parts;
  }

  async function roundCosts(sessionId, turn, eventIds, at) {
    if (typeof estimateRoundCosts !== 'function') return null;
    const judge = judgeUsageFor(eventIds);
    const reply = [...(replyUsage.get(roundKey(sessionId, turn))?.values() || [])];
    try {
      const value = await estimateRoundCosts({ judge, reply, at });
      return value && typeof value === 'object' ? value : null;
    } catch (error) {
      report('model-cost-estimate-failed', error);
      return null;
    }
  }

  function finishRound({
    sessionId,
    turn,
    eventIds,
    reply,
    source,
    at,
    errorCode,
  }) {
    const ids = [...new Set(Array.isArray(eventIds) ? eventIds : [])].filter(Boolean);
    if (!ids.length) return;
    const key = roundKey(sessionId, turn);
    Promise.resolve()
      .then(async () => {
        const modelCosts = await roundCosts(sessionId, turn, ids, at);
        for (const eventId of ids) {
          observeReplyOnce(
            eventId,
            {
              eventId,
              reply,
              at,
              source,
              ...(modelCosts ? { modelCosts } : {}),
            },
            errorCode,
          );
        }
      })
      .catch((error) => report(errorCode, error))
      .finally(() => {
        replyUsage.delete(key);
        turnModels.delete(key);
      });
  }

  function recordForMessage(sessionId, message) {
    const sourceKey = sourceKeyOf(message);
    if (!sourceKey) return null;
    const mapKey = `${sessionId}\0${sourceKey}`;
    const existing = recordsBySource.get(mapKey);
    if (existing) return existing;
    const eventId = companionEventId(sessionId, sourceKey);
    const record = {
      eventId,
      sessionId,
      sourceKey,
      text: textOfMessage(message),
      turn: currentTurns.get(sessionId) ?? null,
    };
    recordsBySource.set(mapKey, record);
    addRoundEvent(sessionId, record.turn, eventId);
    trimMaps();
    return record;
  }

  function publishCue(outcome, identity) {
    const at = Number(clock());
    const cue = cueFromOutcome(outcome, identity, at);
    if (!cue) return null;
    if (latestCues.get(identity.sessionId)?.eventId === cue.eventId) return cue;
    latestCues.set(identity.sessionId, cue);
    try {
      onCue(cue);
    } catch (error) {
      report('cue-publish-failed', error);
    }
    return cue;
  }

  async function readPresence(sessionId, eventId, now) {
    if (!emotion || typeof emotion.companionContext !== 'function') {
      return { text: '', ack: null };
    }
    try {
      const value = await emotion.companionContext({
        sessionId,
        eventId,
        now,
        markSeen: false,
      });
      if (typeof value === 'string') return { text: value.trim(), ack: null };
      return {
        text: typeof value?.text === 'string' ? value.text.trim() : '',
        ack: value?.ack && typeof value.ack === 'object' ? value.ack : null,
      };
    } catch (error) {
      report('presence-context-failed', error);
      return { text: '', ack: null };
    }
  }

  function observeReplyOnce(eventId, payload, errorCode) {
    if (!eventId || observed.has(eventId) || observing.has(eventId)) return;
    observing.add(eventId);
    Promise.resolve()
      .then(() => emotion.observeReply(payload))
      .then((result) => {
        if (result && result.ok === true) {
          observed.add(eventId);
          return;
        }
        const failure = new Error('companion reply observation degraded');
        failure.code = result && result.code ? String(result.code) : 'observe-reply-rejected';
        report(errorCode, failure);
      })
      .catch((error) => {
        report(errorCode, error);
      })
      .finally(() => {
        observing.delete(eventId);
      });
  }

  async function judgeRecord(record, signal) {
    if (outcomes.has(record.eventId)) return outcomes.get(record.eventId);
    if (!record.text) return { ok: false, code: 'empty-utterance' };
    const history = recent.get(record.sessionId) || [];
    const envelope = {
      eventId: record.eventId,
      channel: COMPANION_CHANNEL,
      at: Number(clock()),
      source: `chat:${String(record.sessionId).slice(-8)}`,
      input: {
        utterance: record.text,
        recent: history
          .map((item) => `${item.role === 'user' ? '他' : '她'}：${item.text}`)
          .slice(-4),
        isOwner: true,
        isGroup: false,
      },
      relationshipRef: COMPANION_RELATIONSHIP_REF,
      legacyRelationshipRef: `dsh:${record.sessionId}`,
    };
    let outcome;
    try {
      outcome = await emotion.judge(envelope);
    } catch (error) {
      report('judge-threw', error);
      return { ok: false, code: 'judge_failed' };
    }
    if (signal && signal.aborted) return { ok: false, code: 'judge_aborted' };
    if (outcome && typeof outcome === 'object') {
      const remembered = outcome.llm && typeof outcome.llm === 'object'
        ? { ...outcome, llm: { ...outcome.llm, at: Number(clock()) } }
        : { ...outcome, llm: { at: Number(clock()) } };
      outcomes.set(record.eventId, remembered);
      while (outcomes.size > MAX_RECORDS) outcomes.delete(outcomes.keys().next().value);
      return remembered;
    }
    return outcome || { ok: false, code: 'judge_failed' };
  }

  /**
   * Cordis `agent/pre-step` 处理器。
   *
   * 先让下游监听器给出最终决定；只有真正进入模型步骤且会话显式登记为 chat
   * 时，才判读/注入。任何判读失败都返回原 decision，不阻断陪伴回复。
   */
  async function preStep(payload, next, isCompanionSession) {
    const decision = await next();
    if (
      closed
      || !decision
      || decision.kind !== 'enter'
      || payload?.signal?.aborted
    ) return decision;
    try {
      if (!canInjectContext()) {
        report('prompt-context-unavailable', new Error('prompt-context-unavailable'));
        return decision;
      }
    } catch (error) {
      report('prompt-context-check-failed', error);
      return decision;
    }

    const agent = payload?.agent;
    const sessionId = String(agent?.id || agent?.session?.id || '');
    if (!sessionId || typeof isCompanionSession !== 'function' || !isCompanionSession(sessionId)) {
      return decision;
    }
    const companionDecision = withoutCompanionWorkGuidance(decision);

    const turn = Number(payload?.turn);
    if (Number.isFinite(turn)) currentTurns.set(sessionId, turn);

    const messages = Array.isArray(companionDecision?.messages)
      ? companionDecision.messages
      : [];
    const users = messages.filter((message) => sourceKeyOf(message) && textOfMessage(message));
    if (!users.length) return companionDecision;

    conversationContexts.delete(sessionId);
    pendingPresenceAcks.delete(sessionId);
    const nextContexts = [];
    let lastEventId = '';
    let sawCrisis = false;
    for (const message of users) {
      const record = recordForMessage(sessionId, message);
      if (!record) continue;
      addRoundEvent(sessionId, currentTurns.get(sessionId), record.eventId);
      lastEventId = record.eventId;
      const outcome = await judgeRecord(record, payload.signal);
      if (payload?.signal?.aborted) return companionDecision;
      if (outcome?.ok) {
        if (outcome.crisis === true) sawCrisis = true;
        const text = normalizeContext(outcome);
        if (text) nextContexts.push(text);
        publishCue(outcome, {
          eventId: record.eventId,
          sessionId,
          turn: currentTurns.get(sessionId),
        });
      } else if (outcome?.code) {
        try {
          log(
            Object.assign(new Error('companion judge degraded'), { code: outcome.code }),
            'judge-degraded',
          );
        } catch {
          /* ignore */
        }
      }
    }

    if (!sawCrisis) {
      const presence = await readPresence(sessionId, lastEventId, Number(clock()));
      if (presence.text) nextContexts.unshift(presence.text);
      if (presence.ack) pendingPresenceAcks.set(sessionId, presence.ack);
    }

    const activity = activityContextText(activityContexts.get(sessionId), {
      now: Number(clock()),
    });
    if (activity) nextContexts.unshift(activity);

    const context = [...new Set(nextContexts)].join('\n\n');
    if (context) {
      conversationContexts.set(sessionId, context);
    }
    return companionDecision;
  }

  /**
   * 处理一条已持久化的 Session 事件。只由 chat 通道调用。
   */
  function observeDurableEvent(sessionId, event) {
    if (closed || !event || typeof event !== 'object') return;
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    if (event.type === 'turn/start') {
      const turn = Number(data.turn);
      if (Number.isFinite(turn)) currentTurns.set(sessionId, turn);
      return;
    }
    const identity = observeModelEvent(sessionId, event);
    if (event.type === 'user/message') {
      const source = data.source && typeof data.source === 'object' ? data.source : {};
      const identityMessage = {
        id: data.id,
        source,
        content: data.content,
      };
      const record = recordForMessage(sessionId, identityMessage);
      if (!record) return;
      const turn = currentTurns.get(sessionId);
      if (turn != null) record.turn = turn;
      addRoundEvent(sessionId, turn, record.eventId);
      rememberRecent(sessionId, 'user', textOfMessage(identityMessage));
      return;
    }
    if (event.type === 'assistant/message') {
      const turn = Number.isFinite(Number(data.turn))
        ? Number(data.turn)
        : currentTurns.get(sessionId);
      rememberReplyUsage(sessionId, turn, event, identity);
      const text = replyText(event);
      if (turn != null && text) {
        const key = roundKey(sessionId, turn);
        // One turn can contain a pre-tool assistant step and a post-tool step.
        // For the owner, the visible result is the last step. Replacing here
        // keeps dashboard replay aligned with the desktop transcript and avoids
        // persisting a duplicated draft as the reply to this turn.
        replies.set(key, text.slice(0, 8000));
        rememberRecent(sessionId, 'assistant', text);
      }
      return;
    }
    if (event.type !== 'turn/end') return;

    const turn = Number.isFinite(Number(data.turn))
      ? Number(data.turn)
      : currentTurns.get(sessionId);
    if (turn == null) return;
    currentTurns.set(sessionId, turn);
    const key = roundKey(sessionId, turn);
    const reply = replies.get(key) || '';
    const eventIds = [...(rounds.get(key) || [])];
    finishRound({
      sessionId,
      turn,
      eventIds,
      reply,
      at: Number(clock()),
      source: 'dsh-companion',
      errorCode: 'reply-observe-failed',
    });
    trimMaps();
  }

  /**
   * 重连快照中对账已完成轮次。看板 attachReply 本身按 eventId 幂等；
   * 协调器再按进程去重，避免每次重连重复调用。
   */
  function reconcileSnapshot(sessionId, records) {
    if (closed) return;
    const localReplies = new Map();
    const localRounds = new Map();
    for (const record of Array.isArray(records) ? records : []) {
      const event = eventOfRecord(record);
      if (!event || typeof event.type !== 'string') continue;
      const data = event.data && typeof event.data === 'object' ? event.data : {};
      if (event.type === 'turn/start') {
        const turn = Number(data.turn);
        if (Number.isFinite(turn)) currentTurns.set(sessionId, turn);
        continue;
      }
      const identity = observeModelEvent(sessionId, event);
      if (event.type === 'user/message') {
        const identityMessage = {
          id: data.id,
          source: data.source,
          content: data.content,
        };
        const recordValue = recordForMessage(sessionId, identityMessage);
        if (!recordValue) continue;
        const turn = currentTurns.get(sessionId);
        if (turn != null) {
          recordValue.turn = turn;
          localRounds.set(turn, [...(localRounds.get(turn) || []), recordValue.eventId]);
          addRoundEvent(sessionId, turn, recordValue.eventId);
        }
        continue;
      }
      if (event.type === 'assistant/message') {
        const turn = Number.isFinite(Number(data.turn))
          ? Number(data.turn)
          : currentTurns.get(sessionId);
        rememberReplyUsage(sessionId, turn, event, identity);
        const text = replyText(event);
        if (turn != null && text) {
          localReplies.set(turn, text);
        }
        continue;
      }
      if (event.type !== 'turn/end') continue;
      const turn = Number.isFinite(Number(data.turn))
        ? Number(data.turn)
        : currentTurns.get(sessionId);
      if (turn == null) continue;
      const ids = [...new Set([
        ...(localRounds.get(turn) || []),
        ...(rounds.get(roundKey(sessionId, turn)) || []),
      ])];
      const reply = localReplies.get(turn)
        || replies.get(roundKey(sessionId, turn))
        || '';
      finishRound({
        sessionId,
        turn,
        eventIds: ids,
        reply,
        at: Number(clock()),
        source: 'dsh-companion-snapshot',
        errorCode: 'snapshot-observe-failed',
      });
    }
  }

  return {
    preStep,
    observeDurableEvent,
    reconcileSnapshot,
    contextText(sessionId) {
      const id = String(sessionId || '');
      const proactive = proactiveContexts.get(id) || '';
      if (proactive) proactiveContexts.delete(id);
      const text = [conversationContexts.get(id) || '', proactive]
        .filter(Boolean)
        .join('\n\n');
      const ack = pendingPresenceAcks.get(id);
      if (ack) {
        pendingPresenceAcks.delete(id);
        Promise.resolve()
          .then(() => emotion.acknowledgeCompanionContext?.(ack))
          .catch((error) => report('presence-ack-failed', error));
      }
      return text;
    },
    /**
     * 主动消息投递前写入一次内部上下文。保留到 systemPrompt 真正读取；
     * 投递失败时可显式清除，避免污染下一轮主人发言。
     */
    setProactiveContext(sessionId, value) {
      const id = String(sessionId || '');
      const text = String(value || '').trim();
      if (!id || !text) return false;
      pendingPresenceAcks.delete(id);
      proactiveContexts.set(id, text.slice(0, 8000));
      while (proactiveContexts.size > MAX_RECORDS) {
        proactiveContexts.delete(proactiveContexts.keys().next().value);
      }
      return true;
    },
    clearProactiveContext(sessionId) {
      return proactiveContexts.delete(String(sessionId || ''));
    },
    /**
     * 只保存经过收窄的短快照；null 会立即清掉上一轮，避免暂停后继续使用
     * 旧软件事实。该方法不启动模型、不落盘。
     */
    setActivityContext(sessionId, value, now = Number(clock())) {
      const id = String(sessionId || '');
      if (!id) return false;
      if (value == null) {
        activityContexts.delete(id);
        return true;
      }
      if (!activityContextText(value, { now })) {
        activityContexts.delete(id);
        return false;
      }
      activityContexts.set(id, value);
      while (activityContexts.size > MAX_RECORDS) {
        activityContexts.delete(activityContexts.keys().next().value);
      }
      return true;
    },
    latestActivity(sessionId) {
      return activityContexts.get(String(sessionId || '')) || null;
    },
    latestCue(sessionId) {
      return latestCues.get(String(sessionId || '')) || null;
    },
    status() {
      return {
        records: recordsBySource.size,
        rounds: rounds.size,
        observed: observed.size,
        observing: observing.size,
        contexts: conversationContexts.size,
        proactiveContexts: proactiveContexts.size,
        cachedOutcomes: outcomes.size,
        replyUsageRounds: replyUsage.size,
      };
    },
    close() {
      closed = true;
      recordsBySource.clear();
      rounds.clear();
      outcomes.clear();
      recent.clear();
      currentTurns.clear();
      latestCues.clear();
      conversationContexts.clear();
      activityContexts.clear();
      proactiveContexts.clear();
      pendingPresenceAcks.clear();
      observed.clear();
      observing.clear();
      replies.clear();
      turnModels.clear();
      sessionModels.clear();
      replyUsage.clear();
    },
  };
}
