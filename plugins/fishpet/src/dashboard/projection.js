/**
 * DSH 看板的唯一 Host 投影入口。
 *
 * 浏览器的输入只来自这里：六轴、表达、这一轮、旧账、内里、本地活动、只读观测历史
 * 和运行状态。投影刻意不含关系 scope、actor id、绝对路径、凭据或原始状态文件；
 * 它也不会顺手执行修整函数，避免“打开看板”改变任何情绪。
 *
 * @module dsh-fishpet-emotion/dashboard/projection
 */

import { moodView } from '../engine/state.js';
import { vitalitySnapshot } from '../life/vitality.js';
import { humanizeAssistantVoice } from '../bridge/lib/reduce.js';
import { summarizeObservedUsage } from './usage.js';

export const DASHBOARD_SCHEMA = 1;

export const AXIS_DEFINITIONS = Object.freeze([
  {
    key: 'valence',
    name: '心情',
    range: [-100, 100],
    center: 0,
    description: '整体好不好受。负数是难受，正数是舒服。',
  },
  {
    key: 'energy',
    name: '精力',
    range: [0, 100],
    center: null,
    description: '她这轮还剩多少力气；聊天和熬夜都会消耗。',
  },
  {
    key: 'arousal',
    name: '唤醒',
    range: [-100, 100],
    center: 0,
    description: '情绪的起伏和紧绷程度；高低都不等于心情好坏。',
  },
  {
    key: 'dominance',
    name: '底气',
    range: [-100, 100],
    center: 0,
    description: '她有没有底气、能不能稳住自己。',
  },
  {
    key: 'clinginess',
    name: '黏人',
    range: [0, 100],
    center: null,
    description: '想不想被理、愿不愿意主动靠近。',
  },
  {
    key: 'trust',
    name: '信任',
    range: [-50, 100],
    center: 0,
    description: '她愿不愿意把他的话当真；这是慢变量。',
  },
]);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 1) {
  const scale = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
}

function text(value, limit = 2000) {
  const raw = typeof value === 'string' ? value : '';
  return raw.length > limit ? raw.slice(0, limit) : raw;
}

function toMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number >= 10_000_000_000 ? number : number * 1000;
}

function toSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number >= 10_000_000_000 ? number / 1000 : number;
}

function axisLabel(key, value) {
  const number = Number(value);
  if (key === 'valence') {
    return number <= -40 ? '很差' : number <= -10 ? '不太好' : number < 20 ? '平静' : number < 50 ? '不错' : '很好';
  }
  if (key === 'energy') {
    return number < 20 ? '快没电了' : number < 45 ? '有点累' : number < 75 ? '正常' : '精神';
  }
  if (key === 'arousal') {
    return number < -40 ? '很安静' : number < -10 ? '有点低' : number < 20 ? '平常' : number < 50 ? '有点上头' : '很激动';
  }
  if (key === 'dominance') {
    return number < -50 ? '很没底' : number < -15 ? '有点虚' : number < 15 ? '平常心' : number < 50 ? '有底气' : '很笃定';
  }
  if (key === 'clinginess') {
    return number < 25 ? '想一个人待着' : number < 50 ? '正常' : number < 75 ? '有点黏' : '很想被理';
  }
  return number <= -30 ? '不太敢信' : number < 15 ? '半信半疑' : number < 55 ? '还算信得过' : '很信';
}

function axisDescription(key, value) {
  if (key !== 'trust') return '';
  const number = Number(value);
  if (number <= -30) return '她会先掂量，是不是又在哄她。';
  if (number < 15) return '话会听，但先不全信。';
  if (number < 55) return '愿意把他的话当真。';
  return '基本不怀疑他。';
}

export function buildAxes(mood, nowMs) {
  const now = toSeconds(nowMs);
  const view = moodView(isObject(mood) ? mood : {}, now);
  return AXIS_DEFINITIONS.map((definition) => {
    const value = round(finite(view[definition.key], 0), 1);
    return {
      ...definition,
      value,
      displayValue: definition.key === 'valence' && value > 0 ? `+${value}` : String(value),
      label: axisLabel(definition.key, value),
      note: axisDescription(definition.key, value),
      position: Math.max(
        0,
        Math.min(
          100,
          ((value - definition.range[0]) / (definition.range[1] - definition.range[0])) * 100,
        ),
      ),
    };
  });
}

function mapExtreme(mood) {
  const items = Array.isArray(mood?.extreme?.items) ? mood.extreme.items : [];
  const entered = isObject(mood?.extreme?.entered_at) ? mood.extreme.entered_at : {};
  return items
    .filter((item) => isObject(item))
    .slice(0, 4)
    .map((item) => {
      const at = toSeconds(entered[String(item.key || '')] || 0);
      return {
        key: text(item.key, 24),
        label: text(item.label, 24),
        locked: item.locked === true,
        value: finite(item.value, 0),
        at,
      };
    });
}

function buildActivity(mood, vitality, nowMs) {
  const now = toSeconds(nowMs);
  const last = toSeconds(mood?.last_user_msg_at);
  const energy = finite(vitality?.energy, finite(mood?.energy, 65));
  if (!last) {
    return {
      kind: 'new',
      label: '还没聊过，在等你开口',
      ageSeconds: 0,
    };
  }
  const age = Math.max(0, now - last);
  if (vitality?.sleeping === true) {
    return { kind: 'sleeping', label: '睡着了，先别叫醒', ageSeconds: round(age, 0) };
  }
  if (age < 10 * 60) {
    return { kind: 'chat', label: '刚跟你聊完，还在', ageSeconds: round(age, 0) };
  }
  if (age < 30 * 60) {
    return { kind: 'awake', label: '醒着，等你说话', ageSeconds: round(age, 0) };
  }
  if (energy < 12) {
    return { kind: 'away', label: '有一阵没聊了，累得在安静待着', ageSeconds: round(age, 0) };
  }
  return { kind: 'away', label: '有一阵没聊了，自己在待着', ageSeconds: round(age, 0) };
}

function flattenEpisodes(episodes) {
  const scopes = isObject(episodes?.scopes) ? episodes.scopes : {};
  const out = [];
  for (const bucket of Object.values(scopes)) {
    if (!isObject(bucket) || !Array.isArray(bucket.items)) continue;
    for (const item of bucket.items) if (isObject(item)) out.push(item);
  }
  return out;
}

function episodeView(item) {
  const openedAt = toSeconds(item.opened_at);
  const lastMentionAt = toSeconds(item.last_mention);
  return {
    type: text(item.type, 12),
    label: text(item.label, 24),
    quote: text(item.quote, 220),
    quotes: Array.isArray(item.quotes) ? item.quotes.slice(-4).map((entry) => text(entry, 160)) : [],
    emo: text(item.emo, 20),
    who: text(item.who, 24),
    magnitude: round(finite(item.mag, 0), 1),
    mentions: Math.max(1, Math.trunc(finite(item.mentions, 1))),
    recalls: Math.max(0, Math.trunc(finite(item.recalls, 0))),
    openedAt,
    lastMentionAt,
    lastRecalledAt: toSeconds(item.last_recalled),
    asks: Math.max(0, Math.trunc(finite(item.asks, 0))),
    lastAskAt: toSeconds(item.last_ask_at),
    solved: item.solved === true,
    noEvidence: item.no_evidence === true,
    closedAt: toSeconds(item.closed_at),
    closedBy: text(item.closed_by, 80),
  };
}

function buildEpisodes(layer2, nowMs) {
  const all = flattenEpisodes(layer2?.episodes).map(episodeView);
  const now = toSeconds(nowMs);
  const open = all
    .filter((item) => !item.solved && !item.closedBy)
    .sort((left, right) => right.lastMentionAt - left.lastMentionAt)
    .slice(0, 16);
  const good = all
    .filter((item) => item.type === '亲近' && now - item.lastMentionAt <= 14 * 86400)
    .sort((left, right) => right.lastMentionAt - left.lastMentionAt)
    .slice(0, 5);
  return {
    open,
    good,
    openCount: all.filter((item) => !item.solved && !item.closedBy).length,
  };
}

function buildInner(layer2) {
  const inner = isObject(layer2?.inner) ? layer2.inner : {};
  const memory = isObject(layer2?.coreMemory) ? layer2.coreMemory : {};
  return {
    gaps: (Array.isArray(inner.gaps) ? inner.gaps : [])
      .filter(isObject)
      .slice(-12)
      .reverse()
      .map((item) => ({
        text: text(item.text, 160),
        createdAt: toSeconds(item.created_at),
        sharedAt: toSeconds(item.shared_at),
      })),
    scars: (Array.isArray(inner.scars) ? inner.scars : [])
      .filter(isObject)
      .slice(-8)
      .reverse()
      .map((item) => ({
        topic: text(item.topic, 80),
        core: text(item.core, 40),
        createdAt: toSeconds(item.created_at),
        hits: Math.max(0, Math.trunc(finite(item.hits, 0))),
      })),
    coreMemory: (Array.isArray(memory.entries) ? memory.entries : [])
      .filter((item) => isObject(item) && (item.status || 'active') === 'active')
      .slice(-30)
      .reverse()
      .map((item) => ({
        text: text(item.text, 320),
        createdAt: toSeconds(item.created_at),
        createdDate: text(item.created_date, 24),
        by: text(item.by, 60),
      })),
  };
}

function buildLocalLife(layer2, nowMs) {
  const background = isObject(layer2?.background) ? layer2.background : {};
  const rawActivity = isObject(background.local_activity) ? background.local_activity : null;
  const activityText = rawActivity ? text(rawActivity.text, 120).trim() : '';
  return {
    localActivity: activityText
      ? {
        text: activityText,
        kind: text(rawActivity.kind, 24),
        level: Math.max(0, Math.trunc(finite(rawActivity.level, 0))),
        startedAt: toSeconds(rawActivity.started_at),
        seenAt: toSeconds(rawActivity.seen_at),
      }
      : null,
    lastPassAt: toSeconds(background.last_pass_at),
    now: toSeconds(nowMs),
  };
}

function currentFallback(layer2) {
  const emotion = isObject(layer2?.emotion) ? layer2.emotion : {};
  const event = isObject(layer2?.lastEvent) ? layer2.lastEvent : null;
  const action = isObject(layer2?.lastAction) ? layer2.lastAction : null;
  if (!event && !action && !emotion.at) return null;
  return {
    id: 'state-fallback',
    at: toMs(emotion.at || action?.at || layer2?.updatedAt),
    status: 'legacy',
    user: '',
    reply: null,
    attempts: null,
    errorCode: '',
    feeling: {
      words: Array.isArray(emotion.feelings) ? emotion.feelings.slice(0, 3).map((word) => text(word, 40)) : [],
      carry: text(emotion.carry, 12),
      letGo: text(emotion.letGo, 120),
    },
    action: action
      ? {
        final: text(action.act, 16),
        proposed: text(action.model, 16),
        reason: '',
        changed: Boolean(action.downgraded),
        downgraded: action.downgraded === true,
        blocked: false,
      }
      : null,
    event: event
      ? {
        type: text(event.type, 12),
        quote: text(event.quote, 160),
        what: text(event.what, 160),
        label: text(event.label, 24),
        who: text(event.who, 8),
        weight: finite(event.weight, 0),
        unsolved: event.unsolved !== false,
      }
      : null,
    episode: null,
    judgement: isObject(layer2?.judgement)
      ? { text: text(layer2.judgement.text, 80), at: toSeconds(layer2.judgement.at) }
      : null,
    judgementLast: isObject(layer2?.judgementLast)
      ? {
        text: text(layer2.judgementLast.text, 80),
        update: layer2.judgementLast.update === true,
        reason: text(layer2.judgementLast.reason, 120),
        drift: finite(layer2.judgementLast.drift, 0),
        at: toSeconds(layer2.judgementLast.at),
      }
      : null,
    beats: [],
    mask: null,
    surge: null,
    sting: null,
    extreme: mapExtreme(layer2?.mood),
    axesBefore: null,
    axesAfter: null,
    delta: {},
    usage: null,
    modelCosts: null,
    read: null,
    monologue: null,
    available: { reply: false, read: false, monologue: false, modelUsage: false },
  };
}

function maybeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeAxes(value) {
  if (!isObject(value)) return null;
  const keys = ['valence', 'energy', 'arousal', 'dominance', 'clingy', 'clinginess', 'trust'];
  const out = {};
  for (const key of keys) {
    const number = maybeNumber(value[key]);
    if (number !== null) out[key] = round(number, 1);
  }
  return Object.keys(out).length ? out : null;
}

function safeSignal(value) {
  if (!isObject(value)) return null;
  return {
    kind: text(value.kind, 24),
    level: maybeNumber(value.level),
    q: text(value.q, 120),
  };
}

function safeRoundUsage(value) {
  if (!isObject(value)) return null;
  const keys = [
    'calls',
    'inputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'billedInputTokens',
    'outputTokens',
    'totalTokens',
    'reasoningTokens',
    'cost',
  ];
  const out = {};
  for (const key of keys) {
    const number = maybeNumber(value[key]);
    if (number !== null) out[key] = Math.max(0, number);
  }
  if (!Object.keys(out).length) return null;
  out.currency = text(value.currency, 8);
  out.source = text(value.source, 40);
  return out;
}

function safeRoleCost(value) {
  if (!isObject(value)) return null;
  const status = ['estimated', 'partial', 'unavailable'].includes(value.status)
    ? value.status
    : 'unavailable';
  const cost = maybeNumber(value.cost);
  return {
    status,
    estimated: value.estimated === true,
    cost: cost === null ? null : Math.max(0, cost),
    currency: text(value.currency || 'CNY', 8),
    symbol: text(value.symbol || '¥', 8),
    source: text(value.source, 40),
    reason: text(value.reason, 80),
    provider: text(value.provider, 120),
    model: text(value.model, 120),
    calls: Math.max(0, Math.trunc(finite(value.calls, 0))),
    usage: safeRoundUsage(value.usage),
  };
}

function safeModelCosts(value) {
  if (!isObject(value)) return null;
  const judge = safeRoleCost(value.judge);
  const reply = safeRoleCost(value.reply);
  if (!judge && !reply) return null;
  const total = maybeNumber(value.totalCny);
  return {
    version: Math.max(1, Math.trunc(finite(value.version, 1))),
    status: ['estimated', 'partial', 'unavailable'].includes(value.status)
      ? value.status
      : 'unavailable',
    currency: text(value.currency || 'CNY', 8),
    symbol: text(value.symbol || '¥', 8),
    source: text(value.source || 'dsh-cost-meter-price', 40),
    totalCny: total === null ? null : Math.max(0, total),
    judge,
    reply,
  };
}

function safeCalculation(value) {
  if (!isObject(value)) return null;
  const burst = isObject(value.burst)
    ? {
      key: text(value.burst.key, 16),
      delta: maybeNumber(value.burst.delta),
      why: text(value.burst.why, 80),
    }
    : null;
  const regulation = isObject(value.regulation)
    ? {
      strategy: text(value.regulation.strategy, 24),
      summary: text(value.regulation.summary, 120),
    }
    : null;
  return {
    proposedDelta: safeAxes(value.proposedDelta),
    before: safeAxes(value.before),
    after: safeAxes(value.after),
    burst,
    regulation,
  };
}

function safeInsight(value, label, fallbackAt) {
  if (!isObject(value)) return null;
  const spoken = text(value.text, 120).trim();
  if (!spoken) return null;
  if (/(系统提示|提示词|系统消息|模型输出|模型内部|工具调用|函数调用|内部推理|JSON|schema|reasoning|assistant|prompt|tool\s*call)/i.test(spoken)) {
    return null;
  }
  return {
    text: spoken,
    at: toSeconds(value.at || fallbackAt),
    source: text(value.source || label, 40),
  };
}

function safeRound(round, index) {
  if (!isObject(round)) return null;
  const at = toMs(round.at);
  if (!at) return null;
  const reply = isObject(round.reply)
    ? {
      text: text(humanizeAssistantVoice(round.reply.text), 4000),
      at: toMs(round.reply.at),
      source: text(round.reply.source, 40),
    }
    : null;
  const feeling = isObject(round.feeling) ? round.feeling : {};
  const action = isObject(round.action) ? round.action : {};
  const event = isObject(round.event) ? round.event : {};
  const episode = isObject(round.episode) ? round.episode : {};
  const judgement = isObject(round.judgement) ? round.judgement : {};
  const judgementLast = isObject(round.judgementLast) ? round.judgementLast : {};
  const available = isObject(round.available) ? round.available : {};
  const read = isObject(round.read)
    ? safeInsight({
      ...round.read,
      source: round.read.source || 'legacy-read',
    }, 'legacy-read', at)
    : null;
  const monologue = safeInsight(round.monologue, 'small-model', at);
  return {
    id: `round-${index}-${Math.trunc(at)}`,
    at,
    status: ['ok', 'failed', 'crisis', 'blocked'].includes(round.status) ? round.status : 'ok',
    crisis: round.crisis === true,
    user: text(round.user, 1000),
    reply: reply && reply.text ? reply : null,
    attempts: maybeNumber(round.attempts),
    errorCode: text(round.errorCode, 80),
    feeling: {
      words: Array.isArray(feeling.words) ? feeling.words.slice(0, 3).map((word) => text(word, 40)) : [],
      carry: text(feeling.carry, 12),
      letGo: text(feeling.letGo, 120),
    },
    action: {
      final: text(action.final, 16),
      proposed: text(action.proposed, 16),
      reason: text(action.reason, 160),
      changed: action.changed === true,
      downgraded: action.downgraded === true,
      blocked: action.blocked === true,
    },
    event: {
      type: text(event.type, 12),
      quote: text(event.quote, 160),
      what: text(event.what, 160),
      label: text(event.label, 24),
      who: text(event.who, 8),
      weight: maybeNumber(event.weight),
      unsolved: event.unsolved !== false,
    },
    episode: {
      logged: episode.logged === true,
      why: text(episode.why, 60),
      reopened: episode.reopened === true,
      duplicate: episode.duplicate === true,
      type: text(episode.type, 12),
      quote: text(episode.quote, 160),
      emo: text(episode.emo, 20),
      label: text(episode.label, 24),
      mentions: Math.max(0, Math.trunc(finite(episode.mentions, 0))),
      openedAt: toSeconds(episode.openedAt),
      lastMentionAt: toSeconds(episode.lastMentionAt),
      noEvidence: episode.noEvidence === true,
      solved: episode.solved === true,
    },
    judgement: {
      text: text(judgement.text, 80),
      at: toSeconds(judgement.at),
    },
    judgementLast: {
      text: text(judgementLast.text, 80),
      update: judgementLast.update === true,
      reason: text(judgementLast.reason, 120),
      drift: maybeNumber(judgementLast.drift),
      at: toSeconds(judgementLast.at),
    },
    beats: Array.isArray(round.beats)
      ? round.beats.filter(isObject).slice(0, 4).map((beat) => ({
        q: text(beat.q, 80),
        v: maybeNumber(beat.v),
      }))
      : [],
    mask: safeSignal(round.mask),
    surge: safeSignal(round.surge),
    sting: safeSignal(round.sting),
    extreme: Array.isArray(round.extreme)
      ? round.extreme.filter(isObject).slice(0, 4).map((item) => ({
        key: text(item.key, 24),
        label: text(item.label, 24),
        side: text(item.side, 12),
        locked: item.locked === true,
        value: maybeNumber(item.value),
        at: toSeconds(item.at),
      }))
      : [],
    axesBefore: safeAxes(round.axesBefore),
    axesAfter: safeAxes(round.axesAfter),
    delta: safeAxes(round.delta) || {},
    calculation: safeCalculation(round.calculation),
    usage: safeRoundUsage(round.usage),
    modelCosts: safeModelCosts(round.modelCosts),
    read,
    monologue,
    available: {
      reply: available.reply === true || Boolean(reply?.text),
      read: Boolean(read?.text),
      monologue: Boolean(monologue?.text),
      modelUsage: available.modelUsage === true,
    },
  };
}

/**
 * 生成完整、脱敏、只读的看板快照。
 *
 * @param {object} options
 * @param {object} options.layer1 第一层状态（仅用于元信息）。
 * @param {object} options.layer2 第二层状态。
 * @param {object} options.usage 当前累计用量。
 * @param {object} options.runtime 插件/LLM/后台状态。
 * @param {object[]} options.rounds 最近逐轮观测（已从私有历史读取）。
 * @param {object[]} options.points 七天内六轴采样点。
 * @param {object|null} [options.observedUsageSummary] 全量观测历史的用量汇总。
 * @param {object} options.historyStatus 观测历史状态。
 * @param {number} [options.now] 毫秒时钟。
 * @param {string} [options.pluginVersion] 插件版本。
 * @returns {object}
 */
export function buildDashboardProjection({
  layer1,
  layer2,
  usage,
  runtime,
  rounds = [],
  points = [],
  observedUsageSummary = null,
  historyStatus = {},
  now = Date.now(),
  pluginVersion = '',
}) {
  const at = Number(now);
  const mood = isObject(layer2?.mood) ? layer2.mood : {};
  const emotion = isObject(layer2?.emotion) ? layer2.emotion : {};
  const vitality = isObject(layer2?.vitality) ? layer2.vitality : {};
  const cleanRounds = rounds.map(safeRound).filter(Boolean);
  const fallback = currentFallback(layer2);
  const currentRound = cleanRounds[0] || fallback;
  const axes = buildAxes(mood, at);
  const spirit = vitalitySnapshot(vitality);
  const episodes = buildEpisodes(layer2, at);
  const inner = buildInner(layer2);
  const background = buildLocalLife(layer2, at);
  const extremes = mapExtreme(mood);
  const usageSummary = isObject(observedUsageSummary)
    && isObject(observedUsageSummary.today)
    ? observedUsageSummary
    : summarizeObservedUsage(cleanRounds, at);
  const lastEventAt = Math.max(
    toMs(layer1?.updatedAt),
    toMs(layer2?.updatedAt),
    toMs(usage?.lastJudgeAt),
    toMs(historyStatus?.latestAt),
  );

  return {
    schemaVersion: DASHBOARD_SCHEMA,
    generatedAt: at,
    pluginVersion: text(pluginVersion, 40),
    readonly: true,
    source: {
      kind: 'dsh',
      role: 'emotion-dashboard',
      mobileMemorySystem: false,
      note: '只显示情绪系统当前实际写入的事件、内里、识海与本地活动；不包含另一套手机记忆系统。',
    },
    activity: buildActivity(mood, vitality, at),
    her: {
      name: '小肥鱼',
      totalTurns: Math.max(0, Math.trunc(finite(vitality.turns, 0))),
    },
    now: {
      feelings: Array.isArray(emotion.feelings) ? emotion.feelings.slice(0, 3).map((word) => text(word, 40)) : [],
      emo: text(emotion.emo, 40),
      extreme: {
        label: text(mood?.extreme?.label, 80),
        items: extremes,
      },
      spirit: {
        value: spirit.energy,
        label: spirit.state,
        note: '这里只有一个精力/体力合成轴；旧看板把两项相加的“精神”值不再重复显示。',
      },
    },
    axes,
    currentRound,
    rounds: cleanRounds,
    history: {
      hours: 168,
      points: Array.isArray(points)
        ? points.slice(0, 1000).map((point) => ({
          at: toMs(point.at),
          axes: isObject(point.axes) ? point.axes : {},
        }))
        : [],
      status: {
        available: historyStatus?.available !== false,
        records: Math.max(0, Math.trunc(finite(historyStatus?.records, 0))),
        earliestAt: toMs(historyStatus?.earliestAt),
        latestAt: toMs(historyStatus?.latestAt),
        retentionDays: finite(historyStatus?.retentionDays, 7),
        lastError: text(historyStatus?.lastError, 80),
      },
    },
    episodes,
    inner,
    background,
    runtime: {
      ready: runtime?.ready !== false,
      readonly: runtime?.readonly === true,
      closed: runtime?.closed === true,
      schemaVersion: finite(runtime?.schemaVersion || layer2?.schemaVersion, 0),
      dataDirName: text(runtime?.dataDirName, 80),
      llm: {
        available: runtime?.llm?.available === true,
        provider: text(runtime?.llm?.provider, 120),
        model: text(runtime?.llm?.model, 120),
        route: text(runtime?.llm?.source, 80),
        reason: text(runtime?.llm?.reason, 80),
      },
      background: isObject(runtime?.background) ? runtime.background : {},
      budget: isObject(runtime?.budget)
        ? {
          day: text(runtime.budget.day, 16),
          calls: Math.max(0, Math.trunc(finite(runtime.budget.calls, 0))),
          inputTokens: Math.max(0, Math.trunc(finite(runtime.budget.inputTokens, 0))),
          outputTokens: Math.max(0, Math.trunc(finite(runtime.budget.outputTokens, 0))),
          totalTokens: Math.max(0, Math.trunc(finite(runtime.budget.totalTokens, 0))),
          cost: Math.max(0, finite(runtime.budget.cost, 0)),
          currency: text(runtime.budget.currency, 8),
          consecutiveFailures: Math.max(0, Math.trunc(finite(runtime.budget.consecutiveFailures, 0))),
          circuitOpenUntil: toMs(runtime.budget.circuitOpenUntil),
          circuitOpen: runtime.budget.circuitOpen === true,
          unavailable: runtime.budget.unavailable === true,
          limitMode: text(runtime.budget.limitMode, 16),
          overLimit: runtime.budget.overLimit === true,
          warnings: Array.isArray(runtime.budget.warnings)
            ? runtime.budget.warnings.slice(0, 3).map((warning) => ({
              code: text(warning?.code, 40),
              reason: text(warning?.reason, 16),
              used: Math.max(0, finite(warning?.used, 0)),
              limit: Math.max(0, finite(warning?.limit, 0)),
            }))
            : [],
          limits: isObject(runtime.budget.limits)
            ? {
              dailyCallLimit: Math.max(0, Math.trunc(finite(runtime.budget.limits.dailyCallLimit, 0))),
              dailyTokenLimit: Math.max(0, Math.trunc(finite(runtime.budget.limits.dailyTokenLimit, 0))),
              dailyCostLimit: Math.max(0, finite(runtime.budget.limits.dailyCostLimit, 0)),
              consecutiveFailureLimit: Math.max(0, Math.trunc(finite(runtime.budget.limits.consecutiveFailureLimit, 0))),
              circuitCooldownMs: Math.max(0, Math.trunc(finite(runtime.budget.limits.circuitCooldownMs, 0))),
            }
            : {},
        }
        : null,
      stats: isObject(runtime?.stats) ? runtime.stats : {},
      usage: {
        judged: Math.max(0, Math.trunc(finite(usage?.judged, 0))),
        failed: Math.max(0, Math.trunc(finite(usage?.failed, 0))),
        degraded: Math.max(0, Math.trunc(finite(usage?.degraded, 0))),
        lastJudgeAt: toMs(usage?.lastJudgeAt),
      },
      observedUsage: usageSummary,
      lastUpdatedAt: lastEventAt,
      limitations: [
        '逐轮完整回放从本版本开始记录；更早轮次没有的数据不补造。',
        '回复需要桥接层在 envelope.reply 传入，或判读后调用 observeReply；未采集时会明确显示。',
        '逐轮费用按 DSH 当前价目与真实 usage 估算；缺 token 或价格时明确写“未采集”，不会补成假金额。',
        '新版已经取消“值不值得判读”的分流；成功进入判读的轮次不再伪造旧 triage。',
      ],
    },
  };
}

