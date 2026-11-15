/**
 * 陪伴时钟：记录程序运行、用户互动和两次运行之间的大致空档。
 *
 * 程序关闭时无法继续观测电脑，所以这里不冒充操作系统关机事件。它只在下次
 * 启动时用“上次心跳到本次启动”的间隔估算陪伴程序停止或电脑关闭的时间，
 * 并在首次安装时明确保持为零。
 *
 * @module dsh-fishpet-emotion/life/presence
 */

import { randomUUID } from 'node:crypto';
import { promises as nodeFs } from 'node:fs';
import path from 'node:path';

import { readJson, writeJsonAtomic } from '../store/atomic-json.js';

export const PRESENCE_SCHEMA_VERSION = 1;
export const PRESENCE_FILE = 'presence-state.json';
export const DEFAULT_HEARTBEAT_MS = 60_000;
export const MAX_OFFLINE_SEC = 365 * 86400;
export const RETURN_NOTICE_MIN_SEC = 10 * 60;
export const IDLE_NOTICE_MIN_SEC = 30 * 60;
export const RUNTIME_NOTICE_MIN_SEC = 30 * 60;

/**
 * @param {number} value
 * @returns {number}
 */
function finiteStamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * @param {number} value
 * @returns {number}
 */
function finiteSeconds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

/**
 * @param {number} now
 * @param {string} [sessionId]
 * @returns {object}
 */
export function createPresenceState(now = Date.now(), sessionId = randomUUID()) {
  const stamp = finiteStamp(now);
  return {
    schemaVersion: PRESENCE_SCHEMA_VERSION,
    firstSeenAt: stamp,
    lastHeartbeatAt: 0,
    lastInteractionAt: 0,
    lastInteractionEventId: '',
    lastIdleSec: 0,
    lastRunStartedAt: stamp,
    totalRuntimeSec: 0,
    lastOfflineSec: 0,
    lastReturnAt: 0,
    lastReturnNoticeAt: 0,
    sessionId: String(sessionId || randomUUID()),
  };
}

/**
 * @param {unknown} input
 * @param {{now?: number, sessionId?: string}} [options]
 * @returns {object}
 */
export function normalizePresenceState(input, options = {}) {
  const now = finiteStamp(options.now ?? Date.now());
  const blank = createPresenceState(now, options.sessionId);
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Number(input.schemaVersion) !== PRESENCE_SCHEMA_VERSION) {
    return blank;
  }
  return {
    schemaVersion: PRESENCE_SCHEMA_VERSION,
    firstSeenAt: finiteStamp(input.firstSeenAt) || now,
    lastHeartbeatAt: finiteStamp(input.lastHeartbeatAt),
    lastInteractionAt: finiteStamp(input.lastInteractionAt),
    lastInteractionEventId: String(input.lastInteractionEventId || '').slice(0, 240),
    lastIdleSec: finiteSeconds(input.lastIdleSec),
    lastRunStartedAt: finiteStamp(input.lastRunStartedAt) || now,
    totalRuntimeSec: finiteSeconds(input.totalRuntimeSec),
    lastOfflineSec: Math.min(MAX_OFFLINE_SEC, finiteSeconds(input.lastOfflineSec)),
    lastReturnAt: finiteStamp(input.lastReturnAt),
    lastReturnNoticeAt: finiteStamp(input.lastReturnNoticeAt),
    sessionId: String(input.sessionId || blank.sessionId).slice(0, 120),
  };
}

/**
 * 上次心跳到本次启动之间的空档。时钟倒退、异常未来值都收敛为零。
 *
 * @param {number} previousHeartbeatAt
 * @param {number} now
 * @param {number} [maxSec]
 * @returns {number}
 */
export function offlineGapSeconds(previousHeartbeatAt, now, maxSec = MAX_OFFLINE_SEC) {
  const previous = finiteStamp(previousHeartbeatAt);
  const current = finiteStamp(now);
  if (!previous || !current || current <= previous) return 0;
  return Math.min(
    Math.max(0, Number(maxSec) || MAX_OFFLINE_SEC),
    Math.floor((current - previous) / 1000)
  );
}

/**
 * 给模型看的粗粒度时长，不输出原始秒数。
 *
 * @param {number} seconds
 * @returns {string}
 */
export function describeDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 60) return '不到一分钟';
  if (total < 3600) return `约${Math.max(1, Math.round(total / 60))}分钟`;
  if (total < 86400) {
    const hours = Math.floor(total / 3600);
    const minutes = Math.round((total % 3600) / 60);
    return minutes >= 10 ? `约${hours}小时${minutes}分钟` : `约${hours}小时`;
  }
  const days = Math.floor(total / 86400);
  const hours = Math.round((total % 86400) / 3600);
  return hours > 0 ? `约${days}天${hours}小时` : `约${days}天`;
}

/**
 * 读取当前状态并组织成模型可自然使用的短事实。
 *
 * @param {object} state
 * @param {number} now
 * @returns {{lines: string[], returnPending: boolean, idleSec: number, runtimeSec: number}}
 */
export function presenceFacts(stateInput, now) {
  const state = normalizePresenceState(stateInput, { now });
  const current = finiteStamp(now);
  const runtimeSec = current >= state.lastRunStartedAt
    ? Math.floor((current - state.lastRunStartedAt) / 1000)
    : 0;
  // Idle means "the program was running, but the user did not interact with
  // the companion". Never count the gap between the previous process and this
  // startup a second time as online idle time.
  // `lastIdleSec` is the pending reminder measured when the latest user turn
  // arrived. Do not derive a second fallback from lastInteractionAt: after a
  // restart that would describe the offline interval as time the PC was on.
  const idleSec = state.lastIdleSec;
  const liveIdleStart = Math.max(state.lastInteractionAt, state.lastRunStartedAt);
  const liveIdleSec = liveIdleStart && current >= liveIdleStart
    ? Math.floor((current - liveIdleStart) / 1000)
    : 0;
  const returnPending = state.lastOfflineSec >= RETURN_NOTICE_MIN_SEC
    && state.lastReturnAt > state.lastReturnNoticeAt;
  const lines = [];

  if (returnPending) {
    lines.push(
      `她这次醒来前，家里暗了${describeDuration(state.lastOfflineSec)}。` +
      '这是重新亮起来时才知道的近似时长；她可以自然提一次想念，但不要说自己看见了关闭期间发生的事。'
    );
  }
  if (idleSec >= IDLE_NOTICE_MIN_SEC) {
    lines.push(
      `这次消息之前，主人在电脑开着的情况下已经${describeDuration(idleSec)}没来找她。` +
      '她可以有点闷、损一句或继续自己玩，但不要连续催问为什么不理她。'
    );
  }
  if (runtimeSec >= RUNTIME_NOTICE_MIN_SEC) {
    lines.push(
      `这次她已经在家里醒着${describeDuration(runtimeSec)}，电脑也一直开着。` +
      '她知道电脑还开着；除非主人问，不必主动精确报时。'
    );
  }
  return { lines, returnPending, idleSec, liveIdleSec, runtimeSec };
}

/**
 * @param {object} input
 * @returns {object}
 */
function safeLog(log, input) {
  try {
    log(String(input || '').slice(0, 240));
  } catch {
    /* 日志异常不能影响陪伴状态 */
  }
}

/**
 * @param {string} file
 * @param {object} fs
 * @returns {Promise<void>}
 */
async function backUpCorruptFile(file, fs) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(path.dirname(file), `presence-state.corrupt-${stamp}.json`);
  try {
    await fs.copyFile(file, target);
  } catch {
    /* 备份失败仍继续创建新状态；原路径下若存在坏文件会在下一次原子写时被替换 */
  }
}

/**
 * 创建陪伴时钟。首次调用会立即读取/初始化文件，运行期由低频心跳补充写盘。
 *
 * @param {object} options
 * @param {string} options.dir 私有数据目录。
 * @param {() => number} [options.clock]
 * @param {number} [options.heartbeatMs]
 * @param {number} [options.maxOfflineSec]
 * @param {boolean} [options.autoHeartbeat]
 * @param {object} [options.fs]
 * @param {(line: string) => void} [options.log]
 * @returns {object}
 */
export function createPresenceClock({
  dir,
  clock = () => Date.now(),
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  maxOfflineSec = MAX_OFFLINE_SEC,
  autoHeartbeat = true,
  fs = nodeFs,
  log = () => {},
}) {
  if (!dir || typeof dir !== 'string') throw new TypeError('presence dir required');
  const file = path.join(dir, PRESENCE_FILE);
  const intervalMs = Math.max(10_000, Math.min(24 * 3600 * 1000, Number(heartbeatMs) || DEFAULT_HEARTBEAT_MS));
  const offlineCap = Math.max(60, Math.min(MAX_OFFLINE_SEC, Number(maxOfflineSec) || MAX_OFFLINE_SEC));
  let state = null;
  let timer = null;
  let closed = false;
  let writeChain = Promise.resolve({ ok: true });

  function nowMs() {
    const value = Number(clock());
    return Number.isFinite(value) && value > 0 ? value : Date.now();
  }

  function enqueueWrite() {
    const payload = { ...state };
    writeChain = writeChain
      .catch(() => ({ ok: false, code: 'previous-write-failed' }))
      .then(() => writeJsonAtomic(file, payload, { fs }))
      .then((result) => {
        if (!result.ok) safeLog(log, `[presence] write failed code=${result.code || 'io-error'}`);
        return result;
      });
    return writeChain;
  }

  const ready = (async () => {
    await fs.mkdir(dir, { recursive: true });
    const loaded = await readJson(file, { fs });
    const now = nowMs();
    const previous = loaded.ok ? normalizePresenceState(loaded.value, { now }) : null;
    if (loaded.corrupt) await backUpCorruptFile(file, fs);
    if (!loaded.ok && !loaded.missing) {
      safeLog(log, `[presence] read failed code=${loaded.code || 'io-error'}`);
    }

    if (!previous) {
      state = createPresenceState(now);
      state.lastHeartbeatAt = now;
      state.lastReturnAt = now;
      state.lastReturnNoticeAt = now;
    } else {
      const gap = offlineGapSeconds(previous.lastHeartbeatAt, now, offlineCap);
      state = {
        ...previous,
        lastOfflineSec: gap,
        lastRunStartedAt: now,
        lastHeartbeatAt: now,
        lastReturnAt: now,
        lastIdleSec: 0,
        sessionId: randomUUID(),
      };
      if (gap < RETURN_NOTICE_MIN_SEC) state.lastReturnNoticeAt = now;
    }
    await enqueueWrite();
    if (autoHeartbeat && !closed) {
      timer = setInterval(() => {
        heartbeat().catch(() => {});
      }, intervalMs);
      timer.unref?.();
    }
    return snapshot();
  })();
  ready.catch(() => {});

  /**
   * 返回只含当前陪伴事实的视图。
   *
   * @param {{at?: number}} [options]
   * @returns {object}
   */
  function snapshot(options = {}) {
    const current = finiteStamp(options.at) || nowMs();
    const base = state || createPresenceState(current);
    const facts = presenceFacts(base, current);
    return {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      firstSeenAt: base.firstSeenAt,
      lastHeartbeatAt: base.lastHeartbeatAt,
      lastInteractionAt: base.lastInteractionAt,
      lastRunStartedAt: base.lastRunStartedAt,
      totalRuntimeSec: base.totalRuntimeSec,
      lastOfflineSec: base.lastOfflineSec,
      lastReturnAt: base.lastReturnAt,
      lastReturnNoticeAt: base.lastReturnNoticeAt,
      sessionId: base.sessionId,
      returnPending: facts.returnPending,
      idleSec: facts.liveIdleSec,
      pendingIdleSec: facts.idleSec,
      runtimeSec: facts.runtimeSec,
      closed,
    };
  }

  /**
   * 运行中低频推进心跳；累计运行时不会把关闭期间算进去。
   *
   * @param {{at?: number}} [options]
   * @returns {Promise<object>}
   */
  async function heartbeat(options = {}) {
    await ready;
    if (closed) return snapshot(options);
    const current = finiteStamp(options.at) || nowMs();
    const previous = state.lastHeartbeatAt;
    if (current >= previous) {
      const delta = Math.min(current - previous, intervalMs * 10) / 1000;
      state.totalRuntimeSec += Math.max(0, delta);
      state.lastHeartbeatAt = current;
    }
    await enqueueWrite();
    return snapshot({ at: current });
  }

  /**
   * 每个用户事件只推进一次互动时间；同一 eventId 重放不会把“多久没来”清零两次。
   *
   * @param {{at?: number, eventId?: string}} [options]
   * @returns {Promise<object>}
   */
  async function touchInteraction(options = {}) {
    await ready;
    if (closed) return snapshot(options);
    const current = finiteStamp(options.at) || nowMs();
    const eventId = String(options.eventId || '').slice(0, 240);
    if (eventId && eventId === state.lastInteractionEventId) {
      return {
        ...snapshot({ at: current }),
        duplicate: true,
        lastIdleSec: state.lastIdleSec,
      };
    }
    const previous = state.lastInteractionAt;
    const idleBaseline = Math.max(previous, state.lastRunStartedAt);
    const idleSec = idleBaseline && current >= idleBaseline
      ? Math.floor((current - idleBaseline) / 1000)
      : 0;
    if (previous && current < previous) {
      safeLog(log, '[presence] clock moved backwards; interaction gap clamped to zero');
    }
    // Keep an unacknowledged reminder until it was actually injected. A quick
    // follow-up message must not replace a long absence with a tiny gap.
    state.lastIdleSec = Math.max(state.lastIdleSec, idleSec);
    state.lastInteractionAt = current;
    state.lastInteractionEventId = eventId;
    await enqueueWrite();
    return {
      ...snapshot({ at: current }),
      duplicate: false,
      lastIdleSec: idleSec,
    };
  }

  /**
   * 组织本轮模型可见的陪伴时钟上下文。默认在同一轮消费掉“刚回来”和旧空闲提醒。
   *
   * @param {{at?: number, markSeen?: boolean}} [options]
   * @returns {Promise<{text: string, snapshot: object, ack: object}>}
   */
  async function formatContext(options = {}) {
    await ready;
    const current = finiteStamp(options.at) || nowMs();
    const facts = presenceFacts(state, current);
    const markSeen = options.markSeen !== false;
    const ack = {
      returnAt: facts.returnPending ? state.lastReturnAt : 0,
      idleSec: facts.idleSec,
    };
    let changed = false;
    if (markSeen && facts.returnPending) {
      state.lastReturnNoticeAt = state.lastReturnAt;
      changed = true;
    }
    if (markSeen && state.lastIdleSec > 0) {
      state.lastIdleSec = 0;
      changed = true;
    }
    if (changed) await enqueueWrite();
    const text = facts.lines.length
      ? [
        '【她在家里的时间感】',
        ...facts.lines,
        '以上是她对时间和陪伴的记忆。自然当成自己的感受使用，不要输出计时字段或原始秒数。',
      ].join('\n')
      : '';
    return { text, snapshot: snapshot({ at: current }), ack };
  }

  /**
   * Confirm a previewed reminder reached the model context. If context-message
   * construction fails, the caller skips this method and the reminder remains
   * pending for the next turn.
   *
   * @param {{returnAt?: number, idleSec?: number}} input
   * @returns {Promise<{ok: boolean, consumed: boolean}>}
   */
  async function acknowledgeContext(input = {}) {
    await ready;
    if (closed) return { ok: false, consumed: false };
    const returnAt = finiteStamp(input.returnAt);
    const idleSec = finiteSeconds(input.idleSec);
    let changed = false;
    if (
      returnAt
      && state.lastReturnAt === returnAt
      && state.lastReturnNoticeAt < state.lastReturnAt
    ) {
      state.lastReturnNoticeAt = state.lastReturnAt;
      changed = true;
    }
    if (idleSec > 0 && state.lastIdleSec === idleSec) {
      state.lastIdleSec = 0;
      changed = true;
    }
    if (changed) await enqueueWrite();
    return { ok: true, consumed: changed };
  }

  /**
   * @returns {Promise<void>}
   */
  async function close() {
    if (closed) return;
    if (timer) clearInterval(timer);
    timer = null;
    const current = nowMs();
    await ready.catch(() => {});
    if (state && current >= state.lastHeartbeatAt) {
      const delta = Math.min(current - state.lastHeartbeatAt, intervalMs * 10) / 1000;
      state.totalRuntimeSec += Math.max(0, delta);
      state.lastHeartbeatAt = current;
    }
    closed = true;
    await enqueueWrite();
  }

  function status() {
    const view = snapshot();
    return {
      available: Boolean(state),
      closed,
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      lastOfflineSec: view.lastOfflineSec,
      idleSec: view.idleSec,
      pendingIdleSec: view.pendingIdleSec,
      runtimeSec: view.runtimeSec,
      returnPending: view.returnPending,
    };
  }

  return {
    file,
    ready,
    snapshot,
    heartbeat,
    touchInteraction,
    formatContext,
    acknowledgeContext,
    close,
    status,
  };
}
