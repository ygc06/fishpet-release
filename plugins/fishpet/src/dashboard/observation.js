/**
 * 把一次判读结果整理成看板观测记录。
 *
 * 本模块只读、纯函数，不写盘也不参与情绪投影。它把“模型本来给什么、证据门
 * 最后留下什么、前后六轴怎么变”保存下来，使逐轮回放能区分真实记录与未采集。
 *
 * @module dsh-fishpet-emotion/dashboard/observation
 */

import { moodView } from '../engine/state.js';
import { resolveAction } from '../engine/actions.js';
import { humanizeAssistantVoice } from '../bridge/lib/reduce.js';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, limit = 4000) {
  const raw = typeof value === 'string' ? value : '';
  return raw.length > limit ? raw.slice(0, limit) : raw;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, Number(value)));
}

function round(value, digits = 1) {
  const scale = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
}

function seconds(nowMs) {
  const value = Number(nowMs);
  if (!Number.isFinite(value) || value <= 0) return Date.now() / 1000;
  return value >= 10_000_000_000 ? value / 1000 : value;
}

/**
 * 统一六轴快照；内部状态量程在这里收敛到看板展示口径。
 *
 * @param {object} mood
 * @param {number} nowMs
 * @returns {{valence:number,energy:number,arousal:number,dominance:number,clinginess:number,trust:number}}
 */
export function axisSnapshot(mood, nowMs) {
  const view = moodView(isObject(mood) ? mood : {}, seconds(nowMs));
  return {
    valence: round(view.valence, 1),
    energy: round(view.energy, 1),
    arousal: round(view.arousal, 1),
    dominance: round(view.dominance, 1),
    clinginess: round(view.clinginess, 1),
    trust: round(view.trust, 1),
  };
}

function extremeSnapshot(mood) {
  const items = Array.isArray(mood?.extreme?.items) ? mood.extreme.items : [];
  const entered = isObject(mood?.extreme?.entered_at) ? mood.extreme.entered_at : {};
  return items
    .filter((item) => isObject(item))
    .slice(0, 4)
    .map((item) => ({
      key: text(item.key, 24),
      label: text(item.label, 24),
      side: text(item.side, 12),
      locked: item.locked === true,
      value: finite(item.value),
      at: finite(entered[String(item.key || '')]),
    }));
}

function replyFromEnvelope(envelope) {
  const input = isObject(envelope?.input) ? envelope.input : {};
  const output = isObject(envelope?.output) ? envelope.output : {};
  const assistant = isObject(envelope?.assistant) ? envelope.assistant : {};
  const candidates = [
    envelope?.assistantReply,
    envelope?.reply,
    input.reply,
    input.assistantReply,
    output.reply,
    output.text,
    assistant.text,
    assistant.reply,
  ];
  const found = candidates.find((entry) => typeof entry === 'string' && entry.trim());
  return found ? text(humanizeAssistantVoice(found), 4000) : '';
}

function usageFromEnvelope(envelope, degraded = [], modelUsage = null) {
  const supplied = isObject(envelope?.observation?.usage)
    ? envelope.observation.usage
    : isObject(envelope?.telemetry?.usage)
      ? envelope.telemetry.usage
      : isObject(envelope?.usage)
        ? envelope.usage
        : {};
  const source = {
    ...(isObject(supplied) ? supplied : {}),
    ...(isObject(modelUsage) ? modelUsage : {}),
  };
  const inputTokens = finite(source.inputTokens ?? source.in ?? source.promptTokens);
  const outputTokens = finite(source.outputTokens ?? source.out ?? source.completionTokens);
  const cacheReadTokens = finite(source.cacheReadTokens ?? source.cache_read_tokens);
  const cacheWriteTokens = finite(source.cacheWriteTokens ?? source.cache_write_tokens);
  const reasoningTokens = finite(source.reasoningTokens ?? source.reasoning_tokens);
  const billedInputTokens = [inputTokens, cacheReadTokens, cacheWriteTokens]
    .filter((value) => value !== null)
    .reduce((sum, value) => sum + Math.max(0, Number(value)), 0);
  const output = outputTokens === null ? null : Math.max(0, Math.trunc(outputTokens));
  const totalTokens = finite(source.totalTokens)
    ?? (billedInputTokens > 0 || output !== null ? billedInputTokens + (output || 0) : null);
  const calls = finite(source.calls);
  const cost = finite(source.cost ?? source.totalCost);
  return {
    calls: calls === null ? null : Math.max(0, Math.trunc(calls)),
    inputTokens: inputTokens === null ? null : Math.max(0, Math.trunc(inputTokens)),
    cacheReadTokens: cacheReadTokens === null ? null : Math.max(0, Math.trunc(cacheReadTokens)),
    cacheWriteTokens: cacheWriteTokens === null ? null : Math.max(0, Math.trunc(cacheWriteTokens)),
    billedInputTokens: billedInputTokens || null,
    outputTokens: output,
    totalTokens: totalTokens === null ? null : Math.max(0, Math.trunc(totalTokens)),
    reasoningTokens: reasoningTokens === null ? null : Math.max(0, Math.trunc(reasoningTokens)),
    cost: cost === null ? null : Math.max(0, cost),
    currency: text(source.currency || '', 8),
    source: text(source.source || (isObject(modelUsage) ? 'dsh-llm' : 'integration'), 40),
    degraded: Array.isArray(degraded) ? degraded.slice(0, 80) : [],
  };
}

function beatsSnapshot(result) {
  return (Array.isArray(result?.beats) ? result.beats : [])
    .filter((item) => isObject(item))
    .slice(0, 4)
    .map((item) => ({ q: text(item.q, 80), v: finite(item.v) ?? 0 }));
}

function signalSnapshot(value) {
  if (!isObject(value)) return null;
  return {
    kind: text(value.kind, 12),
    level: finite(value.level),
    q: text(value.q, 80),
  };
}

function episodeSnapshot(effects) {
  const value = isObject(effects?.episode) ? effects.episode : {};
  const item = isObject(value.item) ? value.item : null;
  return {
    logged: value.logged === true,
    why: text(value.why, 60),
    reopened: value.reopened === true,
    duplicate: value.dup === true,
    type: text(item?.type || '', 12),
    quote: text(item?.quote || '', 160),
    emo: text(item?.emo || '', 20),
    label: text(item?.label || '', 24),
    mentions: finite(item?.mentions) ?? 0,
    openedAt: finite(item?.opened_at),
    lastMentionAt: finite(item?.last_mention),
    noEvidence: item?.no_evidence === true,
    solved: item?.solved === true,
  };
}

function axisNumbers(value) {
  if (!isObject(value)) return null;
  const keys = ['valence', 'energy', 'arousal', 'dominance', 'clingy', 'clinginess', 'trust'];
  const out = {};
  for (const key of keys) {
    const number = finite(value[key]);
    if (number !== null) out[key] = round(number, 2);
  }
  return Object.keys(out).length ? out : null;
}

function calculationSnapshot(rawResult, after) {
  const calc = after?.mood?.calc_last;
  const calculation = isObject(calc) ? calc : null;
  const burst = calculation?.burst ?? rawResult?.burst;
  const directBurst = isObject(burst)
    ? Object.entries(burst).find(([key, value]) => (
      ['valence', 'arousal', 'clingy', 'dominance'].includes(key)
      && finite(value) !== null
    ))
    : null;
  const regulation = calculation?.regulation;
  return {
    proposedDelta: axisNumbers(rawResult?.delta),
    before: axisNumbers(calculation?.before),
    after: axisNumbers(calculation?.after),
    burst: isObject(burst)
      ? {
        key: text(burst.key || directBurst?.[0] || '', 16),
        delta: finite(burst.delta) ?? (directBurst ? finite(directBurst[1]) : null),
        why: text(burst.why, 80),
      }
      : null,
    regulation: isObject(regulation)
      ? {
        strategy: text(regulation.strategy, 24),
        summary: text(regulation.summary, 120),
      }
      : null,
  };
}

/**
 * 生成一轮可持久化观测。调用方只在判读或提交结束后调用；本函数不产生副作用。
 *
 * @param {object} options
 * @returns {object}
 */
export function buildRoundObservation({
  envelope,
  rawResult,
  result,
  before,
  after,
  effects,
  now,
  attempts,
  status = 'ok',
  errorCode = '',
  crisis = false,
  modelUsage = null,
}) {
  const at = Number(now);
  const utterance = text(envelope?.input?.utterance || '', 1000);
  const axesBefore = before ? axisSnapshot(before.mood, at) : null;
  const axesAfter = after ? axisSnapshot(after.mood, at) : axesBefore;
  const delta = axesBefore && axesAfter
    ? Object.fromEntries(
      Object.keys(axesAfter).map((key) => [key, round(Number(axesAfter[key]) - Number(axesBefore[key]), 1)]),
    )
    : {};
  const rawAct = text(rawResult?.act || '', 16);
  const finalAct = text(result?.act || '', 16);
  const quote = text(result?.event?.quote || '', 160);
  const action = resolveAction(
    rawAct,
    result?.event?.type || '',
    Boolean(utterance) && Boolean(quote) && utterance.includes(quote),
    utterance,
  );
  const replyText = replyFromEnvelope(envelope);
  const degraded = Array.isArray(result?.degraded) ? result.degraded.slice(0, 80) : [];
  const judgement = after?.judgement && isObject(after.judgement)
    ? {
      text: text(after.judgement.text, 80),
      at: finite(after.judgement.at),
    }
    : null;
  const judgementLast = after?.judgementLast && isObject(after.judgementLast)
    ? {
      text: text(after.judgementLast.text, 80),
      update: after.judgementLast.update === true,
      reason: text(after.judgementLast.reason, 120),
      drift: finite(after.judgementLast.drift),
      at: finite(after.judgementLast.at),
    }
    : null;

  return {
    schemaVersion: 1,
    eventId: text(envelope?.eventId || '', 240),
    at,
    channel: text(envelope?.channel || '', 24),
    status,
    crisis,
    user: utterance,
    reply: replyText
      ? { text: replyText, at, source: 'envelope' }
      : null,
    attempts: Math.max(0, Math.trunc(Number(attempts) || 0)),
    errorCode: text(errorCode, 80),
    read: text(result?.read || '', 80)
      ? {
        text: text(result.read, 80),
        at,
        source: 'small-model',
      }
      : null,
    monologue: text(result?.monologue || '', 220)
      ? {
        text: text(result.monologue, 220),
        at,
        source: 'small-model',
      }
      : null,
    feeling: {
      words: Array.isArray(result?.feelings) ? result.feelings.slice(0, 3).map((word) => text(word, 40)) : [],
      links: Array.isArray(result?.feelLinks) ? result.feelLinks.slice(0, 3) : [],
      emo: text(result?.emo || '', 40),
      mood: text(result?.mood || '', 120),
      state: text(result?.state || '', 1200),
      body: text(result?.body || '', 80),
      carry: text(result?.carry || '', 12),
      letGo: text(result?.let_go || '', 120),
    },
    action: {
      final: finalAct,
      proposed: rawAct,
      reason: text(action.reason, 160),
      changed: Boolean(rawAct && finalAct && rawAct !== finalAct),
      downgraded: Boolean(rawAct && finalAct && rawAct !== finalAct && finalAct === '说难受'),
      blocked: effects?.blocked === true,
    },
    event: {
      type: text(result?.event?.type || '', 12),
      quote,
      what: text(result?.event?.what || '', 160),
      label: text(result?.event?.label || '', 24),
      who: text(result?.event?.who || '', 8),
      weight: finite(result?.event?.weight),
      unsolved: result?.event?.unsolved !== false,
    },
    episode: episodeSnapshot(effects),
    judgement,
    judgementLast,
    beats: beatsSnapshot(result),
    mask: signalSnapshot(result?.mask),
    surge: signalSnapshot(result?.surge),
    sting: signalSnapshot(result?.sting),
    extreme: after ? extremeSnapshot(after.mood) : [],
    axesBefore,
    axesAfter,
    delta,
    calculation: calculationSnapshot(rawResult, after),
    usage: usageFromEnvelope(envelope, degraded, modelUsage),
    available: {
      reply: Boolean(replyText),
      read: Boolean(text(result?.read || '', 80)),
      monologue: Boolean(text(result?.monologue || '', 220)),
      modelUsage: Boolean((() => {
        const supplied = isObject(envelope?.observation?.usage)
          ? envelope.observation.usage
          : isObject(envelope?.telemetry?.usage)
            ? envelope.telemetry.usage
            : isObject(envelope?.usage)
              ? envelope.usage
              : {};
        const sources = [supplied, modelUsage].filter(isObject);
        return sources.some((source) => [
          source.calls,
          source.inputTokens,
          source.outputTokens,
          source.totalTokens,
          source.cacheReadTokens,
          source.cost,
          source.totalCost,
        ].some((value) => finite(value) !== null));
      })()),
    },
  };
}

