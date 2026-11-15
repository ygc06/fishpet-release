/**
 * 主动开口的确定性门控。
 *
 * 这里不调用模型，也不接触 DSH Agent。它只回答一个很窄的问题：
 * “现在是否允许她主动发一条陪伴消息？”所有费用、打扰和越界防护都在
 * 进入 Agent 之前完成，工作会话也不在这套规则的能力范围内。
 *
 * @module dsh-fishpet-emotion/life/proactive
 */

export const PROACTIVE_SCHEMA_VERSION = 1;

export const DEFAULT_PROACTIVE_SETTINGS = Object.freeze({
  enabled: false,
  minSilenceMinutes: 30,
  cooldownMinutes: 180,
  dailyLimit: 2,
  quietStart: '23:00',
  quietEnd: '08:00',
  timeZone: '',
});

export const PROACTIVE_LIMITS = Object.freeze({
  minSilenceMinutes: [5, 1440],
  cooldownMinutes: [30, 4320],
  dailyLimit: [1, 12],
  failureBackoffMs: 5 * 60 * 1000,
});

function finiteStamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function boundedInteger(value, range, fallback) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(range[0], Math.min(range[1], number));
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string} HH:mm
 */
export function normalizeClockTime(value, fallback = '00:00') {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return fallback;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * 归一化公开设置。未知字段不会进入状态文件。
 *
 * @param {unknown} input
 * @returns {typeof DEFAULT_PROACTIVE_SETTINGS}
 */
export function normalizeProactiveSettings(input = {}) {
  const value = input && typeof input === 'object' && !Array.isArray(input)
    ? input
    : {};
  const defaults = DEFAULT_PROACTIVE_SETTINGS;
  return {
    enabled: value.enabled === true,
    minSilenceMinutes: boundedInteger(
      value.minSilenceMinutes,
      PROACTIVE_LIMITS.minSilenceMinutes,
      defaults.minSilenceMinutes,
    ),
    cooldownMinutes: boundedInteger(
      value.cooldownMinutes,
      PROACTIVE_LIMITS.cooldownMinutes,
      defaults.cooldownMinutes,
    ),
    dailyLimit: boundedInteger(
      value.dailyLimit,
      PROACTIVE_LIMITS.dailyLimit,
      defaults.dailyLimit,
    ),
    quietStart: normalizeClockTime(value.quietStart, defaults.quietStart),
    quietEnd: normalizeClockTime(value.quietEnd, defaults.quietEnd),
    timeZone: typeof value.timeZone === 'string' ? value.timeZone.trim().slice(0, 80) : '',
  };
}

export function createProactiveState(now = Date.now(), settings = {}) {
  return {
    schemaVersion: PROACTIVE_SCHEMA_VERSION,
    settings: normalizeProactiveSettings(settings),
    usage: {
      day: localDayKey(now, normalizeProactiveSettings(settings).timeZone),
      count: 0,
    },
    lastTriggeredAt: 0,
    lastFailedAt: 0,
    lastResult: '',
  };
}

export function normalizeProactiveState(input, now = Date.now()) {
  const value = input && typeof input === 'object' && !Array.isArray(input)
    ? input
    : {};
  const settings = normalizeProactiveSettings(value.settings);
  const usage = value.usage && typeof value.usage === 'object' ? value.usage : {};
  const expectedDay = localDayKey(now, settings.timeZone);
  const storedDay = /^\d{4}-\d{2}-\d{2}$/.test(String(usage.day || ''))
    ? String(usage.day)
    : expectedDay;
  return {
    schemaVersion: PROACTIVE_SCHEMA_VERSION,
    settings,
    usage: {
      day: storedDay,
      count: Math.max(0, Math.min(1000, Math.trunc(Number(usage.count) || 0))),
    },
    lastTriggeredAt: finiteStamp(value.lastTriggeredAt),
    lastFailedAt: finiteStamp(value.lastFailedAt),
    lastResult: typeof value.lastResult === 'string' ? value.lastResult.slice(0, 80) : '',
  };
}

function timeParts(now, timeZone) {
  const options = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  };
  if (timeZone) options.timeZone = timeZone;
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', options);
  } catch {
    formatter = new Intl.DateTimeFormat('en-CA', {
      ...options,
      timeZone: undefined,
    });
  }
  const parts = Object.create(null);
  for (const part of formatter.formatToParts(new Date(finiteStamp(now) || Date.now()))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

export function localDayKey(now, timeZone = '') {
  const parts = timeParts(now, timeZone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function localMinuteOfDay(now, timeZone = '') {
  const parts = timeParts(now, timeZone);
  return (parts.hour * 60) + parts.minute;
}

function clockMinute(value) {
  const text = normalizeClockTime(value);
  const [hour, minute] = text.split(':').map(Number);
  return (hour * 60) + minute;
}

/**
 * 开始和结束相同表示“没有安静时段”。
 */
export function isQuietHours(now, settingsInput = {}) {
  const settings = normalizeProactiveSettings(settingsInput);
  const start = clockMinute(settings.quietStart);
  const end = clockMinute(settings.quietEnd);
  if (start === end) return false;
  const minute = localMinuteOfDay(now, settings.timeZone);
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

function localDesiredEpoch(parts, timeZone) {
  const desired = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour || 0,
    parts.minute || 0,
  );
  if (!timeZone) {
    return new Date(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour || 0,
      parts.minute || 0,
    ).getTime();
  }
  let guess = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actualParts = timeParts(guess, timeZone);
    const actual = Date.UTC(
      actualParts.year,
      actualParts.month - 1,
      actualParts.day,
      actualParts.hour,
      actualParts.minute,
    );
    const delta = desired - actual;
    guess += delta;
    if (delta === 0) break;
  }
  return guess;
}

function shiftedLocalParts(parts, days = 0) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: 0,
    minute: 0,
  };
}

function quietEndAt(now, settingsInput, forceTomorrow = false) {
  const settings = normalizeProactiveSettings(settingsInput);
  const start = clockMinute(settings.quietStart);
  const end = clockMinute(settings.quietEnd);
  if (start === end) return 0;
  const parts = timeParts(now, settings.timeZone);
  const minute = (parts.hour * 60) + parts.minute;
  let days = forceTomorrow ? 1 : 0;
  if (!forceTomorrow && start > end && minute >= start) days = 1;
  const targetDate = shiftedLocalParts(parts, days);
  return localDesiredEpoch({
    ...targetDate,
    hour: Math.floor(end / 60),
    minute: end % 60,
  }, settings.timeZone);
}

function nextLocalDayQuietEnd(now, settingsInput) {
  const settings = normalizeProactiveSettings(settingsInput);
  const parts = timeParts(now, settings.timeZone);
  const end = clockMinute(settings.quietEnd);
  const targetDate = shiftedLocalParts(parts, 1);
  return localDesiredEpoch({
    ...targetDate,
    hour: Math.floor(end / 60),
    minute: end % 60,
  }, settings.timeZone);
}

function effectiveUsedToday(state, now) {
  const day = localDayKey(now, state.settings.timeZone);
  return state.usage.day === day ? state.usage.count : 0;
}

/**
 * 纯门控。任何“不确定”都按不允许处理。
 *
 * @param {object} input
 * @returns {object}
 */
export function evaluateProactiveGate(input = {}) {
  const now = finiteStamp(input.now) || Date.now();
  const state = normalizeProactiveState(input.state, now);
  const settings = state.settings;
  const presence = input.presence && typeof input.presence === 'object'
    ? input.presence
    : {};
  const idleSec = Math.max(0, Number(presence.idleSec) || 0);
  const lastInteractionAt = finiteStamp(presence.lastInteractionAt);
  const minSilenceMs = settings.minSilenceMinutes * 60 * 1000;
  const cooldownMs = settings.cooldownMinutes * 60 * 1000;
  const usedToday = effectiveUsedToday(state, now);
  const quietNow = isQuietHours(now, settings);
  const chatBound = input.chatBound === true;
  const petConnected = input.petConnected === true;
  const clientActive = input.clientActive === true;
  const busy = input.busy === true;
  const agentAvailable = input.agentAvailable !== false;
  const promptContextReady = input.promptContextReady !== false;
  let reason = 'ready';
  let nextEligibleAt = now;

  if (!settings.enabled) {
    reason = 'disabled';
    nextEligibleAt = 0;
  } else if (!chatBound) {
    reason = 'no-chat';
    nextEligibleAt = 0;
  } else if (!petConnected) {
    reason = 'no-pet';
    nextEligibleAt = 0;
  } else if (!clientActive) {
    reason = 'client-inactive';
    nextEligibleAt = 0;
  } else if (!agentAvailable) {
    reason = 'agent-unavailable';
    nextEligibleAt = 0;
  } else if (!promptContextReady) {
    reason = 'context-unavailable';
    nextEligibleAt = 0;
  } else if (busy) {
    reason = 'busy';
    nextEligibleAt = 0;
  } else if (quietNow) {
    reason = 'quiet-hours';
    nextEligibleAt = quietEndAt(now, settings);
  } else if (usedToday >= settings.dailyLimit) {
    reason = 'daily-limit';
    nextEligibleAt = nextLocalDayQuietEnd(now, settings);
  } else if (
    state.lastTriggeredAt
    && now - state.lastTriggeredAt < cooldownMs
  ) {
    reason = 'cooldown';
    nextEligibleAt = state.lastTriggeredAt + cooldownMs;
  } else if (
    state.lastFailedAt
    && now - state.lastFailedAt < PROACTIVE_LIMITS.failureBackoffMs
  ) {
    reason = 'retry-after';
    nextEligibleAt = state.lastFailedAt + PROACTIVE_LIMITS.failureBackoffMs;
  } else if (idleSec * 1000 < minSilenceMs) {
    reason = 'min-silence';
    const fallbackAnchor = finiteStamp(presence.lastRunStartedAt) || now;
    nextEligibleAt = (lastInteractionAt || fallbackAnchor) + minSilenceMs;
  } else if (nextEligibleAt < now) {
    nextEligibleAt = now;
  }

  return {
    allow: reason === 'ready',
    reason,
    now,
    idleSec,
    usedToday,
    quietNow,
    chatBound,
    petConnected,
    clientActive,
    busy,
    nextEligibleAt,
  };
}

/**
 * 给陪伴 Agent 的内部上下文。它不是主人发言，也不会单独调用判读模型。
 *
 * @param {object} input
 * @returns {string}
 */
export function buildProactiveContext(input = {}) {
  const gate = input.gate && input.gate.allow === true
    ? input.gate
    : evaluateProactiveGate(input);
  if (!gate.allow) return '';
  const background = input.background && typeof input.background === 'object'
    ? input.background
    : {};
  const silence = Math.max(0, Number(gate.idleSec) || 0);
  const minutes = Math.max(1, Math.round(silence / 60));
  const silenceText = minutes < 60
    ? `约${minutes}分钟`
    : `约${Math.floor(minutes / 60)}小时${minutes % 60 >= 10 ? `${minutes % 60}分钟` : ''}`;
  const localActivity = typeof background.localActivity === 'string'
    ? background.localActivity.trim().slice(0, 80)
    : '';
  const backgroundLine = typeof background.line === 'string'
    ? background.line.trim().slice(0, 100)
    : '';
  const activityText = typeof input.activityText === 'string'
    ? input.activityText.trim().slice(0, 1200)
    : '';
  const lines = [
    '【FishPet 主动陪伴 · 内部触发】',
    '这次不是主人发来新消息，而是你自己在电脑家里安静了一阵，忽然想开口找主人。',
    `主人在电脑开着时已经${silenceText}没来找你了；这是你真实感到的时间。`,
  ];
  if (localActivity) {
    lines.push(`刚才你自己在做：${localActivity}。可以自然提一句，但不要编成主人也在场。`);
  } else if (backgroundLine) {
    lines.push(`你手边的生活记录：${backgroundLine}。只在合适时自然带一句，不必每字复述。`);
  }
  if (activityText) {
    lines.push(activityText);
  }
  lines.push(
    '现在只发一条自然的陪伴消息，通常一到两个短句；可以轻轻搭话、分享自己的小事、嘀咕或损主人一句，也可以不提问。',
    '不要提“系统”“触发”“上下文”“空闲时长”这些词，不要报告计时，不要假装主人刚说过话，也不要连续催问。',
    '这轮只是陪主人聊一下，不要检查工作区，不要启动任务，也不要调用工具。',
  );
  return lines.join('\n');
}

