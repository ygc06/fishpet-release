/**
 * FishPet 统一插件的本机桥接部分。
 *
 * 作用：在 DSH Host 进程里开一个**只绑 127.0.0.1** 的小 HTTP 服务，把
 * sessionController / sessionPersistence / sessionQuery 的能力封成桌宠
 * `dsh-fishpet` 直接可用的 REST + SSE 接口。
 *
 * 合并后还负责把同一插件里的 `fishpetEmotion.dashboard()` 只读快照交给皮套。
 *
 * 边界（第二轮派工单 §五）：
 *  - 只在 chat 通道首次发送时创建陪伴会话；不 append 事件、不写会话日志；
 *  - 不注册 approval answerer，审批只读显示；
 *  - 不外联、零 npm 依赖（只用 node:*）；
 *  - 日志里永不出现 token 与消息正文。
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  MAX_BODY,
  readJsonBody,
  screenRequest,
  sendJson,
} from './lib/guards.js';
import {
  bindingPath,
  discoveryPath,
  dshHome,
  ensureDir,
  newToken,
  readBindings,
  readDiscovery,
  removeDiscoveryIfOwned,
  tokenPath,
  writeBindings,
  writeJsonAtomic,
  writeToken,
} from './lib/discovery.js';
import {
  applyEvent,
  createState,
  deltaText,
  projectTranscript,
  reduceSnapshot,
  trimEvent,
} from './lib/reduce.js';
import { createCompanionCoordinator } from '../host/companion.js';
import {
  combineModelRoleCosts,
  createDshCostEstimator,
} from '../dashboard/cost.js';
import {
  activityContextText,
  normalizeActivityContext,
} from '../host/activity-context.js';
import { parseScreenCapture } from '../host/screen-capture.js';
import { hasExplicitVisualIntent } from '../host/screen-intent.js';
import { buildProactiveContext } from '../life/proactive.js';
import { createProactiveRuntime } from '../life/proactive-runtime.js';

export const name = 'dsh-fishpet-bridge';

/** 依赖：会话读写、持久化 stat、标题折叠与每步动态上下文 */
export const inject = [
  'sessionController',
  'sessionPersistence',
  'sessionQuery',
  'systemPrompt',
  'sessions',
];

const VERSION = '0.9.14';
const DEFAULT_AGENT_PRESET = 'fishpet-xiaoman-v6';
const DEFAULT_PORT = 48720;
const HEARTBEAT_MS = 15_000;
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10_000];
const TEXT_LIMIT = 8000;
const PROACTIVE_TRIGGER_TEXT = 'FishPet 陪伴时钟';
const SCREEN_REQUEST_TIMEOUT_MS = 15_000;
const SCREEN_FRAME_MAX_BYTES = 2 * 1024 * 1024;
const SCREEN_FRAME_BODY_LIMIT = 4 * 1024 * 1024;

let proactiveMessageFactoryPromise = null;

function resolveProactiveMessageFactory() {
  if (!proactiveMessageFactoryPromise) {
    proactiveMessageFactoryPromise = import('@deepseek-ai/dsh-llm')
      .then((mod) => (typeof mod.createUserMessage === 'function' ? mod.createUserMessage : null))
      .catch(() => null);
  }
  return proactiveMessageFactoryPromise;
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function log(...args) {
  // 只打元数据；调用点自己保证不带 token / 正文
  console.log('[fishpet-bridge]', ...args);
}

function dshVersion() {
  const candidates = [];
  if (process.env.DSH_VERSION) return String(process.env.DSH_VERSION);
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'runtime', 'primary-runtime', 'runtime.json'));
  }
  for (const file of candidates) {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      const version = value.desktopVersion ?? value.version;
      if (typeof version === 'string' && version) return version;
    } catch {
      /* 换下一个 */
    }
  }
  return 'unknown';
}

function shortLabel(sessionId, title) {
  if (typeof title === 'string' && title.trim()) return title.trim();
  const tail = String(sessionId ?? '').slice(-6);
  return tail ? `会话 ${tail}` : '未命名会话';
}

function pickTitle(observation) {
  const value = observation && observation.title;
  if (value && typeof value.title === 'string' && value.title.trim()) return value.title.trim();
  return null;
}

function abortAfter(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
  timer.unref?.();
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function snapshotTurn(value) {
  const turn = Number(value);
  return value != null && Number.isFinite(turn) && turn >= 0 ? Math.floor(turn) : 0;
}

function latestTurnBoundary(records) {
  let latest = null;
  for (const record of Array.isArray(records) ? records : []) {
    const event = record?.type === 'event' ? record.event : record;
    if (event?.type !== 'turn/start' && event?.type !== 'turn/end') continue;
    const seq = Number(event.seq);
    if (Number.isFinite(seq) && (latest == null || seq > latest.seq)) {
      latest = { seq, type: event.type };
    }
  }
  return latest;
}

function firstEventSeq(records) {
  let first = null;
  for (const record of Array.isArray(records) ? records : []) {
    const event = record?.type === 'event' ? record.event : record;
    const seq = Number(event?.seq);
    if (Number.isFinite(seq) && (first == null || seq < first)) first = seq;
  }
  return first;
}

function workspaceKey(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const normalized = resolve(text).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function mapWithLimit(items, limit, mapper) {
  const input = Array.isArray(items) ? items : [];
  const results = new Array(input.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), input.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= input.length) return;
        results[index] = await mapper(input[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/* ------------------------------------------------------------------ *
 * SSE 扇出 + follow 循环
 * ------------------------------------------------------------------ */

class FollowHub {
  constructor({
    channel,
    controller,
    sessionId,
    onState,
    bindingProvider,
    emotionProvider,
    onDurableEvent,
    onSnapshot,
  }) {
    this.channel = channel;
    // Companion chat is face-to-face conversation, not a work trace. Keep
    // reasoning available to the work follow stream, but never to chat.
    this.includeReasoning = channel !== 'chat';
    this.controller = controller;
    this.sessionId = sessionId;
    this.onState = onState;
    this.bindingProvider = typeof bindingProvider === 'function' ? bindingProvider : null;
    this.emotionProvider = typeof emotionProvider === 'function' ? emotionProvider : null;
    this.onDurableEvent = typeof onDurableEvent === 'function' ? onDurableEvent : null;
    this.onSnapshot = typeof onSnapshot === 'function' ? onSnapshot : null;
    this.clients = new Set();
    this.ac = null;
    this.loop = null;
    this.state = createState(sessionId);
    this.recent = [];
    this.closed = false;
    this.attempt = 0;
    this.retryTimer = null;
    this.baselineCursor = -1;
  }

  /** 新客户端接入：立刻给一份可用的基线。 */
  attach(res) {
    const client = { res, heartbeat: null };
    this.clients.add(client);
    client.heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        this.detach(client);
      }
    }, HEARTBEAT_MS);
    client.heartbeat.unref?.();
    res.on('close', () => this.detach(client));
    res.on('error', () => this.detach(client));
    this.write(client, 'snapshot', this.snapshotPayload());
    return client;
  }

  detach(client) {
    if (!this.clients.has(client)) return;
    this.clients.delete(client);
    clearInterval(client.heartbeat);
    try {
      client.res.end();
    } catch {
      /* ignore */
    }
  }

  snapshotPayload() {
    // binding 必须进快照：桌宠只靠快照重建基线，缺了这一项它会在每次重连时
    // 把本地标题抹成「未选会话」，要等下一轮轮询才恢复。
    const binding = typeof this.bindingProvider === 'function' ? this.bindingProvider() : null;
    const emotion = typeof this.emotionProvider === 'function' ? this.emotionProvider() : null;
    return {
      channel: this.channel,
      sessionId: this.sessionId,
      cursor: this.baselineCursor >= 0 ? this.baselineCursor : this.state.lastSeq,
      phase: this.state.phase,
      turn: snapshotTurn(this.state.turn),
      approval: this.state.approval,
      binding: binding || null,
      recent: this.recent,
      emotion: emotion || null,
    };
  }

  write(client, eventName, payload, id) {
    if (!this.clients.has(client)) return;
    const lines = [];
    if (id !== undefined && id !== null) lines.push(`id: ${id}`);
    lines.push(`event: ${eventName}`);
    lines.push(`data: ${JSON.stringify(payload)}`);
    try {
      client.res.write(`${lines.join('\n')}\n\n`);
    } catch {
      this.detach(client);
    }
  }

  broadcast(eventName, payload, id) {
    for (const client of [...this.clients]) this.write(client, eventName, payload, id);
  }

  start() {
    if (this.closed) return;
    this.ac = new AbortController();
    const ac = this.ac;
    this.loop = (async () => {
      try {
        const stream = this.controller.follow(
          { address: { kind: 'session', sessionId: this.sessionId }, maxMessages: 120, assistantStream: true },
          ac.signal,
        );
        for await (const frame of stream) {
          if (ac.signal.aborted || this.closed) break;
          await this.handleFrame(frame);
        }
        if (!this.closed && !ac.signal.aborted) this.scheduleRetry('follow-ended');
      } catch (error) {
        if (this.closed || ac.signal.aborted) return;
        this.scheduleRetry('follow-error');
      }
    })();
  }

  async handleFrame(frame) {
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'snapshot') {
      this.attempt = 0;
      const records = await this.backfillSnapshot(frame, this.ac?.signal);
      const reduced = reduceSnapshot(records, frame.cursor, this.sessionId);
      const activeAttempt = frame.assistantStream?.activeAttempt;
      const activeTurn = snapshotTurn(activeAttempt?.turn);
      // 快照基线：不产生任何 notify（历史完成/失败/审批一律不播报）
      this.state = activeAttempt
        ? { ...reduced.state, phase: 'streaming', turn: activeTurn }
        : reduced.state;
      this.recent = projectTranscript(records, 24, {
        includeReasoning: this.includeReasoning,
      });
      this.baselineCursor = Number.isFinite(Number(frame.cursor)) ? Number(frame.cursor) : this.state.lastSeq;
      this.onState?.(this.state);
      this.onSnapshot?.(records);
      this.broadcast('snapshot', this.snapshotPayload());
      return;
    }
    if (frame.type === 'event') {
      const event = frame.event;
      if (!event) return;
      const seq = Number(event.seq);
      // 重复/回退的 seq 一律不广播：SSE 的 id 就是 seq，两帧共用一个 id 会毁掉 Last-Event-ID。
      if (Number.isFinite(seq) && seq <= this.state.lastSeq) return;
      const { state, effects } = applyEvent(this.state, event);
      this.state = state;
      this.onDurableEvent?.(event);
      const transcriptItem = projectTranscript([event], 1, {
        includeReasoning: this.includeReasoning,
      })[0];
      if (transcriptItem) {
        const existing = this.recent.findIndex(
          (item) => item.role === transcriptItem.role && item.seq === transcriptItem.seq,
        );
        if (existing >= 0) this.recent[existing] = transcriptItem;
        else this.recent.push(transcriptItem);
        if (this.recent.length > 24) this.recent.splice(0, this.recent.length - 24);
      }
      this.onState?.(state);
      const trimmed = trimEvent(event, {
        includeReasoning: this.includeReasoning,
      });
      // 运行上下文、时间和记忆注入在持久层仍是 user/message，但它们不是聊天正文。
      // 不广播这类事件，避免桌宠把内部提示伪装成用户新消息。
      if (!trimmed) return;
      this.broadcast('event', trimmed, Number.isFinite(seq) ? seq : undefined);
      this.broadcast('state', { phase: state.phase, turn: state.turn, tool: state.tool });
      for (const effect of effects) {
        if (effect.kind === 'notify') {
          this.broadcast('notify', {
            kind: effect.notifyKind,
            key: effect.key,
            turn: effect.turn,
            detail: effect.detail,
            id: effect.id ?? null,
          });
        } else if (effect.kind === 'truncated') {
          this.broadcast('state', { phase: state.phase, turn: state.turn, tool: null, truncated: true });
        }
      }
      return;
    }
    if (frame.type === 'assistant-stream') {
      const inner = frame.frame;
      if (!inner) return;
      if (inner.type === 'start') {
        this.state = { ...this.state, phase: 'streaming' };
        this.onState?.(this.state);
        this.broadcast('state', { phase: 'streaming', turn: inner.turn ?? this.state.turn, tool: null });
        return;
      }
      if (inner.type === 'chunk') {
        const delta = deltaText(inner, {
          includeReasoning: this.includeReasoning,
        });
        // 桌宠渲染层按 `stream` 读、状态机按 `kind` 读，两个都给（同值），避免歧义。
        if (delta) this.broadcast('delta', { ...delta, stream: delta.kind }); // 绝不带 id
        return;
      }
      if (inner.type === 'end') {
        this.broadcast('delta-end', { reason: inner.outcome?.kind ?? 'unknown' }); // 绝不带 id
      }
    }
  }

  async backfillSnapshot(frame, signal) {
    const records = Array.isArray(frame.records) ? [...frame.records] : [];
    if (frame.hasMore !== true || latestTurnBoundary(records)) return records;
    if (typeof this.controller.page !== 'function') return records;

    let beforeSeq = firstEventSeq(records);
    for (let pageCount = 0; pageCount < 8 && beforeSeq != null; pageCount += 1) {
      let page;
      try {
        page = await this.controller.page({
          address: { kind: 'session', sessionId: this.sessionId },
          throughSeq: Number(frame.cursor),
          beforeSeq,
          maxMessages: 240,
        }, signal);
      } catch {
        log('snapshot backfill failed; using the opening window');
        break;
      }
      if (!page || !Array.isArray(page.records) || page.records.length === 0) break;
      const nextFirst = firstEventSeq(page.records);
      if (nextFirst == null || nextFirst >= beforeSeq) break;
      records.unshift(...page.records);
      beforeSeq = nextFirst;
      if (latestTurnBoundary(records)) break;
      if (page.hasMore !== true) break;
    }
    return records;
  }

  scheduleRetry(reason) {
    if (this.closed || this.retryTimer) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    log(`follow ${reason}; retry in ${delay}ms (attempt ${this.attempt})`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.start();
    }, delay);
    this.retryTimer.unref?.();
  }

  stop(reason = 'shutdown') {
    if (this.closed) return;
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    try {
      this.ac?.abort();
    } catch {
      /* ignore */
    }
    this.broadcast('bye', { reason });
    for (const client of [...this.clients]) this.detach(client);
    this.clients.clear();
  }
}

/* ------------------------------------------------------------------ *
 * 插件主体
 * ------------------------------------------------------------------ */

export function apply(ctx, rawConfig = {}) {
  const config = {
    port: Number.isFinite(Number(rawConfig?.port)) ? Number(rawConfig.port) : DEFAULT_PORT,
    bindHost: typeof rawConfig?.bindHost === 'string' ? rawConfig.bindHost : '127.0.0.1',
    companionCwd: typeof rawConfig?.companionCwd === 'string' ? rawConfig.companionCwd.trim() : '',
    agentPreset: typeof rawConfig?.agentPreset === 'string' && rawConfig.agentPreset.trim()
      ? rawConfig.agentPreset.trim()
      : DEFAULT_AGENT_PRESET,
    restrictCompanionAgent: typeof rawConfig?.restrictCompanionAgent === 'function'
      ? rawConfig.restrictCompanionAgent
      : null,
    diagnoseCompanionAgent: typeof rawConfig?.diagnoseCompanionAgent === 'function'
      ? rawConfig.diagnoseCompanionAgent
      : null,
    screenState: rawConfig?.screenState && typeof rawConfig.screenState === 'object'
      ? rawConfig.screenState
      : null,
    screenToolRegistered: typeof rawConfig?.screenToolRegistered === 'function'
      ? rawConfig.screenToolRegistered
      : () => false,
  };
  if (config.bindHost !== '127.0.0.1') {
    // 绝不允许绑到 0.0.0.0：这个接口能驱动主 Agent。
    log('bindHost 只允许 127.0.0.1，已强制回环');
    config.bindHost = '127.0.0.1';
  }

  const home = dshHome();
  config.companionCwd = resolve(
    home,
    config.companionCwd || join(home, 'fishpet-workspace'),
  );
  const dir = join(home, 'fishpet-bridge');
  ensureDir(dir);
  const dPaths = {
    discovery: discoveryPath(home),
    token: tokenPath(home),
    binding: bindingPath(home),
  };

  const token = newToken();
  writeToken(dPaths.token, token);

  const sc = () => ctx.get('sessionController') ?? ctx.sessionController;
  const sp = () => ctx.get('sessionPersistence') ?? ctx.sessionPersistence;
  const sq = () => ctx.get('sessionQuery') ?? ctx.sessionQuery;
  const emotion = () => ctx.get('fishpetEmotion') ?? ctx.fishpetEmotion;
  const sessions = () => ctx.get('sessions') ?? ctx.sessions;

  const CHANNELS = Object.freeze(['chat', 'work']);
  const SESSION_SCOPES = Object.freeze(['chat', 'work']);
  const bindings = { chat: null, work: null };
  const hubs = { chat: null, work: null };
  const restored = readBindings(dPaths.binding);
  const retiredChatSessionIds = new Set(restored?.retiredChat || []);
  const sessionHeaders = new Map();
  const pendingScreenCaptures = new Map();
  let chatScreenIntent = null;
  const companionWorkspaceKey = workspaceKey(config.companionCwd);
  let companionCreateTask = null;
  let server = null;
  let actualPort = config.port;
  const startedAt = Date.now();
  let proactiveActivity = null;
  let proactiveActivityAt = 0;

  function freshProactiveActivity(now = Date.now()) {
    if (!proactiveActivity || now - proactiveActivityAt > 45_000) return null;
    return proactiveActivity;
  }

  function proactiveClientActive(now = Date.now()) {
    const value = freshProactiveActivity(now);
    if (!value) return false;
    if (value.state !== 'active' || value.idleSec > 120) return false;
    const category = value.app?.category || '';
    return !['chat', 'companion', 'game', 'immersive', 'private'].includes(category);
  }

  function normalizeChannel(value, fallback = 'work') {
    const channel = String(value || '').trim().toLowerCase();
    return CHANNELS.includes(channel) ? channel : fallback;
  }

  function normalizeSessionScope(value, fallback = 'work') {
    const scope = String(value || '').trim().toLowerCase();
    return SESSION_SCOPES.includes(scope) ? scope : fallback;
  }

  function isCompanionWorkspace(cwd) {
    return Boolean(companionWorkspaceKey) && workspaceKey(cwd) === companionWorkspaceKey;
  }

  function screenPayload(now = Date.now()) {
    if (!config.screenState || typeof config.screenState.status !== 'function') {
      return {
        available: false,
        enabled: false,
        ready: false,
        reason: 'screen-unavailable',
        usedToday: 0,
        dailyLimit: 0,
        minIntervalSeconds: 0,
        lastCaptureAt: 0,
        retryAt: 0,
        toolRegistered: false,
      };
    }
    try {
      return {
        available: true,
        ...config.screenState.status(now),
        toolRegistered: config.screenToolRegistered() === true,
      };
    } catch {
      return {
        available: false,
        enabled: false,
        ready: false,
        reason: 'screen-status-unavailable',
        usedToday: 0,
        dailyLimit: 0,
        minIntervalSeconds: 0,
        lastCaptureAt: 0,
        retryAt: 0,
        toolRegistered: false,
      };
    }
  }

  function latestChatActivity() {
    const sessionId = String(bindings.chat?.sessionId || '').trim();
    if (!sessionId) return null;
    return coordinator.latestActivity(sessionId) || null;
  }

  function claimScreenOpportunity(now = Date.now()) {
    const value = chatScreenIntent;
    if (!value || value.expiresAt <= now) {
      chatScreenIntent = null;
      return false;
    }
    const sessionId = String(bindings.chat?.sessionId || '').trim();
    if (!sessionId || value.sessionId !== sessionId) {
      chatScreenIntent = null;
      return false;
    }
    chatScreenIntent = null;
    return true;
  }

  function screenRequestFailure(code, message = code) {
    return Object.assign(new Error(message), { code });
  }

  /**
   * Ask the already-running FishPet desktop process for one frame. The Host
   * performs privacy gating before this function, and the Electron process
   * owns the actual OS screen-capture permission.
   */
  function requestScreenCapture(options = {}) {
    const requestId = randomUUID();
    const signal = options?.signal;
    const timeoutMs = Math.max(
      5_000,
      Math.min(
        20_000,
        Number.isFinite(Number(options?.timeoutMs))
          ? Number(options.timeoutMs)
          : SCREEN_REQUEST_TIMEOUT_MS,
      ),
    );
    const maxWidth = Math.max(
      640,
      Math.min(1600, Number(options?.maxWidth) || 1600),
    );
    const maxHeight = Math.max(
      400,
      Math.min(1200, Number(options?.maxHeight) || 1000),
    );

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(screenRequestFailure('screen-request-aborted'));
        return;
      }
      if (
        !config.screenState
        || typeof config.screenState.enabled !== 'function'
        || config.screenState.enabled() !== true
      ) {
        reject(screenRequestFailure('screen-disabled'));
        return;
      }
      if (
        options?.opportunityClaimed !== true
        && !claimScreenOpportunity()
      ) {
        reject(screenRequestFailure('screen-not-requested'));
        return;
      }
      const hub = hubs.chat;
      if (!hub || hub.clients.size === 0) {
        reject(screenRequestFailure('screen-pet-unavailable'));
        return;
      }

      let settled = false;
      const finish = (error, image) => {
        if (settled) return;
        settled = true;
        pendingScreenCaptures.delete(requestId);
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        if (error) reject(error);
        else resolve(image);
      };
      const onAbort = () => finish(screenRequestFailure('screen-request-aborted'));
      const timer = setTimeout(
        () => finish(screenRequestFailure('screen-pet-timeout')),
        timeoutMs,
      );
      timer.unref?.();
      pendingScreenCaptures.set(requestId, { finish });
      signal?.addEventListener?.('abort', onAbort, { once: true });
      hub.broadcast('screen-request', {
        requestId,
        timeoutMs,
        maxWidth,
        maxHeight,
        quality: 82,
        maxBytes: SCREEN_FRAME_MAX_BYTES,
      });
      if (hub.clients.size === 0) {
        finish(screenRequestFailure('screen-pet-unavailable'));
      }
    });
  }

  let promptContextReady = false;
  const costEstimator = createDshCostEstimator({
    getMeter: () => {
      try {
        return (typeof ctx.get === 'function' ? ctx.get('costMeter') : null)
          || ctx.costMeter
          || null;
      } catch {
        return null;
      }
    },
    log: (line) => log(line),
  });
  const coordinator = createCompanionCoordinator({
    emotion: {
      async judge(envelope) {
        const service = emotion();
        if (!service || typeof service.judge !== 'function') {
          return { ok: false, code: 'emotion-unavailable', attempts: 0 };
        }
        return service.judge(envelope);
      },
      async companionContext(input) {
        const service = emotion();
        if (!service || typeof service.companionContext !== 'function') {
          return { text: '' };
        }
        return service.companionContext(input);
      },
      async acknowledgeCompanionContext(input) {
        const service = emotion();
        if (!service || typeof service.acknowledgeCompanionContext !== 'function') {
          return { ok: false, consumed: false };
        }
        return service.acknowledgeCompanionContext(input);
      },
      async observeReply(input) {
        const service = emotion();
        if (!service || typeof service.observeReply !== 'function') {
          return { ok: false, code: 'emotion-unavailable' };
        }
        return service.observeReply(input);
      },
      async presenceSnapshot() {
        const service = emotion();
        if (!service) return null;
        if (typeof service.presenceSnapshot === 'function') {
          return service.presenceSnapshot();
        }
        if (typeof service.status === 'function') {
          const value = await service.status();
          return value?.presence || null;
        }
        return null;
      },
      async proactiveContext() {
        const service = emotion();
        if (!service || typeof service.proactiveContext !== 'function') {
          return { presence: null, background: {} };
        }
        return service.proactiveContext();
      },
    },
    log: (error, code) => {
      log(`companion ${code || 'failed'}: ${(error && (error.code || error.name)) || 'Error'}`);
    },
    onCue: (cue) => {
      const target = hubs.chat;
      if (target) target.broadcast('emotion', cue);
    },
    canInjectContext: () => promptContextReady,
    estimateRoundCosts: async ({ judge, reply, at }) => {
      const [judgeCost, replyCost] = await Promise.all([
        costEstimator.estimateUsageBatch(judge, { at }),
        costEstimator.estimateUsageBatch(reply, { at }),
      ]);
      return combineModelRoleCosts(judgeCost, replyCost);
    },
  });

  const promptService = ctx.get('systemPrompt') ?? ctx.systemPrompt;
  if (promptService && typeof promptService.context === 'function') {
    try {
      promptService.context({
        name: 'fishpet:companion-emotion',
        order: 130,
        interpolate: false,
        text: (context) => {
          const sessionId = String(context?.agent?.id || '');
          return sessionId ? coordinator.contextText(sessionId) : '';
        },
      });
      promptContextReady = true;
    } catch (error) {
      log(`prompt context registration failed: ${(error && error.name) || 'Error'}`);
    }
  }

  if (typeof ctx.on === 'function') {
    ctx.on('agent/pre-step', (payload, next) => coordinator.preStep(
      payload,
      next,
      (sessionId) => Boolean(bindings.chat && bindings.chat.sessionId === sessionId),
    ));
  }

  const ACTIVE_AGENT_PHASES = new Set([
    'thinking',
    'streaming',
    'tool',
    'waiting_approval',
  ]);

  async function deliverProactiveTurn(input) {
    const sessionId = String(bindings.chat?.sessionId || '').trim();
    if (!sessionId) return { ok: false, code: 'no-chat' };
    if (!hubs.chat || hubs.chat.clients.size === 0) {
      return { ok: false, code: 'no-pet' };
    }
    if (!promptContextReady) return { ok: false, code: 'context-unavailable' };
    if (ACTIVE_AGENT_PHASES.has(hubs.chat.state?.phase)) {
      return { ok: false, code: 'busy' };
    }

    const controller = sc();
    if (!controller || typeof controller.resolveAgent !== 'function') {
      return { ok: false, code: 'agent-unavailable' };
    }
    let resolved;
    try {
      resolved = await controller.resolveAgent(sessionId);
    } catch (error) {
      return {
        ok: false,
        code: error?.code || 'agent-unavailable',
      };
    }
    if (!resolved || resolved.error || !resolved.agent) {
      return {
        ok: false,
        code: resolved?.error?.code || 'agent-unavailable',
      };
    }
    const agent = resolved.agent;
    if (agent.status !== 'idle') return { ok: false, code: 'agent-busy' };

    const context = buildProactiveContext({
      gate: input.gate,
      presence: input.presence,
      background: input.background || {},
      activityText: activityContextText(input.activity, { now: input.gate.now }),
    });
    if (!context) return { ok: false, code: 'context-unavailable' };
    const requestId = randomUUID();

    const factory = await resolveProactiveMessageFactory();
    const messageInput = {
      content: [{ type: 'text', text: PROACTIVE_TRIGGER_TEXT }],
      source: { kind: 'cordis-host-runner' },
    };
    const message = factory
      ? factory(messageInput)
      : Object.freeze({
          ...messageInput,
          id: randomUUID(),
          role: 'user',
        });
    const set = coordinator.setProactiveContext(sessionId, context);
    if (!set) return { ok: false, code: 'context-unavailable' };
    hubs.chat?.broadcast('proactive', {
      channel: 'chat',
      requestId,
      state: 'started',
      at: Date.now(),
    });
    try {
      agent.followup(message);
    } catch (error) {
      coordinator.clearProactiveContext(sessionId);
      hubs.chat?.broadcast('proactive', {
        channel: 'chat',
        requestId,
        state: 'cancelled',
        at: Date.now(),
      });
      return { ok: false, code: error?.code || 'followup-failed' };
    }

    let flushCode = '';
    try {
      const store = sessions();
      if (typeof store?.flush === 'function') {
        const flushed = await store.flush(agent.session);
        if (flushed === false) flushCode = 'flush-degraded';
      }
    } catch (error) {
      flushCode = error?.code || 'flush-failed';
    }
    if (flushCode) log(`proactive followup persisted with ${flushCode}`);
    return {
      ok: true,
      code: flushCode || 'delivered',
      requestId,
    };
  }

  const proactive = createProactiveRuntime({
    dir,
    intervalMs: 60_000,
    getPresence: async () => {
      const service = emotion();
      if (!service) return null;
      if (typeof service.presenceSnapshot === 'function') {
        return service.presenceSnapshot();
      }
      if (typeof service.status === 'function') {
        const value = await service.status();
        return value?.presence || null;
      }
      return null;
    },
    getGateFacts: () => ({
      chatBound: Boolean(bindings.chat?.sessionId),
      petConnected: Boolean(hubs.chat && hubs.chat.clients.size > 0),
      clientActive: proactiveClientActive(),
      busy: ACTIVE_AGENT_PHASES.has(hubs.chat?.state?.phase)
        || bindings.chat?.running === true,
      promptContextReady,
    }),
    initialSettings: rawConfig?.proactive && typeof rawConfig.proactive === 'object'
      ? rawConfig.proactive
      : {},
    materialize: async (input) => {
      let rich = { presence: input.presence, background: {} };
      try {
        const service = emotion();
        if (service && typeof service.proactiveContext === 'function') {
          const value = await service.proactiveContext();
          if (value && typeof value === 'object') {
            rich = {
              presence: value.presence || input.presence,
              background: value.background && typeof value.background === 'object'
                ? value.background
                : {},
            };
          }
        }
      } catch (error) {
        log(`proactive context degraded: ${error?.code || error?.name || 'Error'}`);
      }
      return deliverProactiveTurn({
        gate: input.gate,
        presence: rich.presence,
        background: rich.background,
        activity: freshProactiveActivity(input.gate.now),
      });
    },
    log: (line) => log(line),
  });

  /* ---------- 会话查询 ---------- */

  // 会话列表 + 标题在真机上要 ~6s（83 个会话逐个读标题），所以缓存 8s：
  // 桌宠的状态轮询不该每次都交这份学费。bind/unbind 会主动 invalidate。
  const SESSIONS_TTL_MS = 8000;
  const SESSIONS_LIST_TIMEOUT_MS = 60_000;
  let sessionsCache = null;
  let sessionsCacheAt = 0;
  let sessionsInFlight = null;
  function invalidateSessionsCache() {
    sessionsCache = null;
    sessionsCacheAt = 0;
  }

  async function inspectRootSession(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) return { kind: 'missing', cwd: '' };
    const cached = sessionHeaders.get(id);
    if (cached) return cached;
    const persistence = sp();
    if (!persistence || typeof persistence.stat !== 'function') {
      return { kind: 'unavailable', cwd: '' };
    }
    let snapshot;
    try {
      snapshot = await persistence.stat(id);
    } catch {
      return { kind: 'unavailable', cwd: '' };
    }
    if (!snapshot) return { kind: 'missing', cwd: '' };
    const header = snapshot.header && typeof snapshot.header === 'object'
      ? snapshot.header
      : {};
    const kind = header.parentSession || header.parentSessionId || header.origin === 'subagent'
      ? 'child'
      : 'root';
    const result = {
      kind,
      cwd: typeof header.cwd === 'string' ? header.cwd : '',
      agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : '',
    };
    if (kind === 'root') {
      sessionHeaders.set(id, result);
      while (sessionHeaders.size > 512) {
        sessionHeaders.delete(sessionHeaders.keys().next().value);
      }
    }
    return result;
  }

  function sessionsForScope(rows, scope) {
    if (scope === 'chat') {
      return rows.filter(
        (item) => isCompanionWorkspace(item.cwd) && !retiredChatSessionIds.has(item.sessionId),
      );
    }
    return rows.filter(
      (item) => !isCompanionWorkspace(item.cwd) && !retiredChatSessionIds.has(item.sessionId),
    );
  }

  async function rootSessions({ force = false } = {}) {
    const now = Date.now();
    if (!force && sessionsCache && now - sessionsCacheAt < SESSIONS_TTL_MS) return sessionsCache;
    if (!force && sessionsInFlight) return sessionsInFlight;
    sessionsInFlight = (async () => {
      const controller = sc();
      if (!controller) throw new Error('session-controller-unavailable');
      const { signal, done } = abortAfter(SESSIONS_LIST_TIMEOUT_MS);
      try {
        const value = await controller.list({}, signal);
        const items = Array.isArray(value?.items) ? value.items : [];
        const roots = items.filter(
          (item) => !item.parentSessionId && item.origin !== 'subagent',
        );
        const ids = roots.map((item) => item.sessionId);
        let titles = new Map();
        const query = sq();
        if (query && ids.length > 0 && typeof query.readTitleSnapshots === 'function') {
          try {
            const results = await query.readTitleSnapshots(ids);
            titles = new Map(
              (Array.isArray(results) ? results : [])
                .filter((row) => row && row.status === 'fulfilled')
                .map((row) => [row.sessionId, pickTitle(row.value)])
                .filter(([, title]) => typeof title === 'string' && title),
            );
          } catch {
            /* 标题只是装饰 */
          }
        }
        const rows = await mapWithLimit(roots, 8, async (item) => {
          let cwd = typeof item.cwd === 'string' ? item.cwd : '';
          if (!cwd) {
            const inspected = await inspectRootSession(item.sessionId);
            if (inspected.kind === 'root') cwd = inspected.cwd;
          }
          return {
            sessionId: item.sessionId,
            title: titles.get(item.sessionId) ?? null,
            shortLabel: shortLabel(item.sessionId, titles.get(item.sessionId)),
            updatedAt: Number(item.updatedAt) || 0,
            running: Boolean(item.running),
            blank: Boolean(item.blank),
            cwd,
          };
        });
        rows.sort((a, b) => b.updatedAt - a.updatedAt);
        sessionsCache = rows;
        sessionsCacheAt = Date.now();
        return rows;
      } finally {
        done();
      }
    })().finally(() => {
      sessionsInFlight = null;
    });
    return sessionsInFlight;
  }


  async function rootCheck(sessionId) {
    return (await inspectRootSession(sessionId)).kind;
  }

  function bindingPayload(channel = 'work') {
    const name = normalizeChannel(channel);
    const bound = bindings[name];
    if (!bound) return null;
    return {
      sessionId: bound.sessionId,
      title: bound.title,
      locked: true,
      running: bound.running,
      blank: bound.blank,
      phase: hubs[name] ? hubs[name].state.phase : 'idle',
    };
  }

  function allBindingPayloads() {
    return {
      chat: bindingPayload('chat'),
      work: bindingPayload('work'),
    };
  }

  function persistBindings() {
    writeBindings(dPaths.binding, bindings, retiredChatSessionIds);
  }

  // 只用缓存刷新（O(1)，不阻塞）：/api/status 每 2-3 秒被轮询，绝不能每次都 list() 一遍。
  function applyCachedSummary() {
    if (!sessionsCache) return;
    for (const channel of CHANNELS) {
      const bound = bindings[channel];
      if (!bound) continue;
      const row = sessionsCache.find((item) => item.sessionId === bound.sessionId);
      if (!row) continue;
      bound.running = Boolean(row.running);
      bound.blank = Boolean(row.blank);
      if (row.title) bound.title = row.title;
    }
  }

  // 显式刷新：拿缓存（必要时才真的去问 DSH）。bind 与 /api/sessions 后调用。
  async function refreshBoundSummary({ force = false } = {}) {
    const rows = await rootSessions({ force }).catch(() => null);
    if (!rows) return;
    for (const channel of CHANNELS) {
      const bound = bindings[channel];
      if (!bound) continue;
      const row = rows.find((item) => item.sessionId === bound.sessionId);
      if (!row) continue;
      bound.running = Boolean(row.running);
      bound.blank = Boolean(row.blank);
      if (row.title) bound.title = row.title;
    }
  }

  // 绑定时若缓存里没有标题，单 id 读一次（很快），不要为一条标题去 list 全部会话。
  async function ensureBoundTitle(channel) {
    const bound = bindings[channel];
    if (!bound || bound.title) return;
    const query = sq();
    if (!query || typeof query.readTitleSnapshots !== 'function') return;
    try {
      const rows = await query.readTitleSnapshots([bound.sessionId]);
      const row = Array.isArray(rows) ? rows.find((r) => r && r.status === 'fulfilled') : null;
      const title = pickTitle(row?.value);
      if (title) bound.title = title;
    } catch {
      /* 标题只是装饰 */
    }
  }

  /* ---------- 绑定 ---------- */

  function startFollower(channel) {
    if (hubs[channel]) hubs[channel].stop('rebind');
    hubs[channel] = null;
    const bound = bindings[channel];
    if (!bound) return;
    const controller = sc();
    if (!controller) return;
    const hub = new FollowHub({
      channel,
      controller,
      sessionId: bound.sessionId,
      bindingProvider: () => bindingPayload(channel),
      emotionProvider: channel === 'chat'
        ? () => coordinator.latestCue(bound.sessionId)
        : null,
      onDurableEvent: channel === 'chat'
        ? (event) => coordinator.observeDurableEvent(bound.sessionId, event)
        : null,
      onSnapshot: channel === 'chat'
        ? (records) => coordinator.reconcileSnapshot(bound.sessionId, records)
        : null,
      onState: (state) => {
        if (bound && state) bound.running = ['thinking', 'streaming', 'tool', 'waiting_approval'].includes(state.phase);
      },
    });
    hubs[channel] = hub;
    hub.start();
  }

  async function bindSession(sessionId, channel = 'work', options = {}) {
    const name = normalizeChannel(channel);
    const id = String(sessionId ?? '').trim();
    if (!id) return { status: 400, body: { ok: false, error: 'bad-session-id' } };
    const inspected = await inspectRootSession(id);
    if (inspected.kind === 'missing') {
      return { status: 404, body: { ok: false, error: 'session-not-found' } };
    }
    if (inspected.kind === 'unavailable') {
      return { status: 503, body: { ok: false, error: 'session-inspection-unavailable' } };
    }
    if (inspected.kind !== 'root') {
      return { status: 400, body: { ok: false, error: 'not-a-root-session' } };
    }
    if (name === 'chat' && !isCompanionWorkspace(inspected.cwd)) {
      return { status: 400, body: { ok: false, error: 'not-companion-workspace' } };
    }
    if (
      name === 'work'
      && (isCompanionWorkspace(inspected.cwd) || retiredChatSessionIds.has(id))
    ) {
      return { status: 400, body: { ok: false, error: 'not-work-workspace' } };
    }
    // 冷会话可能不在 list() 里（cwd 为空的会被跳过），stat() 才是存在性权威。
    // 绑定路径不许做全量 list()（真机 83 个会话要 ~6s），先捡缓存，再补单 id 标题。
    const cached = sessionsCache && sessionsCache.find((item) => item.sessionId === id);
    if (name === 'chat' && config.restrictCompanionAgent) {
      try {
        if (!config.restrictCompanionAgent(id)) {
          log('陪伴会话工具策略将在 Agent 创建后重试');
        }
      } catch {
        log('陪伴会话工具策略暂时不可用');
      }
    }
    if (name === 'chat') chatScreenIntent = null;
    bindings[name] = {
      sessionId: id,
      title: cached?.title ?? shortLabel(id, null),
      locked: true,
      running: Boolean(cached?.running),
      blank: Boolean(cached?.blank),
      lockedAt: Date.now(),
      ...(options.agentPreset ? { agentPreset: String(options.agentPreset) } : {}),
    };
    if (options.persist !== false) persistBindings();
    invalidateSessionsCache();
    await ensureBoundTitle(name);
    startFollower(name);
    return {
      status: 200,
      body: {
        ok: true,
        channel: name,
        binding: bindingPayload(name),
        bindings: allBindingPayloads(),
      },
    };
  }

  function unbindSession(channel = 'work') {
    const name = normalizeChannel(channel);
    bindings[name] = null;
    if (name === 'chat') chatScreenIntent = null;
    persistBindings();
    if (hubs[name]) hubs[name].stop('unbind');
    hubs[name] = null;
    invalidateSessionsCache();
    return {
      status: 200,
      body: { ok: true, channel: name, bindings: allBindingPayloads() },
    };
  }

  async function ensureCompanionBinding() {
    const existing = bindings.chat;
    if (existing) {
      const inspected = await inspectRootSession(existing.sessionId);
      if (inspected.kind === 'unavailable') {
        throw Object.assign(
          new Error('session-inspection-unavailable'),
          { code: 'session-inspection-unavailable' },
        );
      }
      const presetCurrent = !config.agentPreset
        || inspected.agentPreset === config.agentPreset;
      if (
        inspected.kind === 'root'
        && isCompanionWorkspace(inspected.cwd)
        && presetCurrent
      ) return existing;
      retiredChatSessionIds.add(existing.sessionId);
      unbindSession('chat');
      log(
        inspected.kind === 'root' && isCompanionWorkspace(inspected.cwd)
          ? '陪伴人设已更新，准备在新会话中启用'
          : '陪伴会话不在独立工作区，准备重新创建',
      );
    }
    if (companionCreateTask) return companionCreateTask;
    companionCreateTask = (async () => {
      const controller = sc();
      if (!controller || typeof controller.create !== 'function') {
        throw Object.assign(new Error('session-controller-unavailable'), { code: 'session-controller-unavailable' });
      }
      try {
        ensureDir(config.companionCwd);
      } catch {
        throw Object.assign(
          new Error('companion-workspace-unavailable'),
          { code: 'companion-workspace-unavailable' },
        );
      }
      const { signal, done } = abortAfter(30_000);
      try {
        const created = await controller.create({
          cwd: config.companionCwd,
          ...(config.agentPreset ? { agentPreset: config.agentPreset } : {}),
        }, signal);
        const sessionId = String(created?.sessionId || '').trim();
        if (!sessionId) {
          throw Object.assign(new Error('companion-create-empty'), { code: 'companion-create-empty' });
        }
        const result = await bindSession(sessionId, 'chat', {
          agentPreset: created?.agentPreset || config.agentPreset,
        });
        if (result.status !== 200) {
          throw Object.assign(new Error('companion-bind-failed'), { code: 'companion-bind-failed' });
        }
        log('已创建陪伴会话', sessionId);
        return bindings.chat;
      } finally {
        done();
      }
    })().finally(() => {
      companionCreateTask = null;
    });
    return companionCreateTask;
  }

  /* ---------- 启动时恢复绑定 ---------- */

  const restoreTask = (async () => {
    if (!restored) return;
    let changed = false;
    for (const channel of CHANNELS) {
      const entry = restored.channels[channel];
      if (!entry) continue;
      if (channel === 'chat') {
        const inspected = await inspectRootSession(entry.sessionId);
        if (
          inspected.kind === 'root'
          && isCompanionWorkspace(inspected.cwd)
          && config.agentPreset
          && inspected.agentPreset !== config.agentPreset
        ) {
          retiredChatSessionIds.add(entry.sessionId);
          bindings.chat = null;
          changed = true;
          log('旧陪伴会话的人设版本已过期，下一条消息将创建新会话');
          continue;
        }
      }
      const result = await bindSession(entry.sessionId, channel, {
        persist: false,
        agentPreset: entry.agentPreset,
      }).catch(() => null);
      if (result && result.status === 200) {
        log(`已恢复${channel}绑定`, entry.sessionId);
      } else {
        if (channel === 'chat') {
          const inspected = await inspectRootSession(entry.sessionId);
          if (inspected.kind === 'root' && !isCompanionWorkspace(inspected.cwd)) {
            retiredChatSessionIds.add(entry.sessionId);
          }
        }
        bindings[channel] = null;
        changed = true;
        log(`${channel}绑定已失效，已清除`);
      }
    }
    if (changed || restored.schema !== 2) persistBindings();
  })();
  restoreTask
    .then(() => proactive.start({ immediate: false }))
    .catch((error) => log(`proactive start skipped: ${error?.code || error?.name || 'Error'}`));

  /* ---------- 路由 ---------- */

  async function handle(req, res) {
    const rejection = screenRequest(req, token);
    if (rejection) {
      sendJson(res, rejection.status, { ok: false, error: rejection.code });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && pathname === '/api/status') {
      await restoreTask;
      applyCachedSummary();
      const binding = bindingPayload('work');
      const channelBindings = allBindingPayloads();
      sendJson(res, 200, {
        ok: true,
        connected: true,
        dsh: true,
        dshVersion: dshVersion(),
        bridge: { schema: 1, pid: process.pid, port: actualPort, startedAt },
        emotion: {
          available: Boolean(emotion()),
          dashboard: true,
        },
        phase: binding ? binding.phase : 'unbound',
        binding,
        bindings: channelBindings,
        companion: {
          channel: 'chat',
          agentPreset: config.agentPreset,
          workspace: 'companion',
          createsOnFirstMessage: true,
          toolPolicy: config.diagnoseCompanionAgent
            ? config.diagnoseCompanionAgent(bindings.chat?.sessionId)
            : null,
        },
        screen: screenPayload(),
        proactive: await proactive.status(),
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/screen') {
      sendJson(res, 200, {
        ok: true,
        value: screenPayload(),
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/screen/frame') {
      const body = await readJsonBody(req, SCREEN_FRAME_BODY_LIMIT);
      const requestId = String(body.requestId || '').trim();
      const pending = pendingScreenCaptures.get(requestId);
      if (!pending) {
        sendJson(res, 409, { ok: false, error: 'screen-request-not-found' });
        return;
      }
      if (body.error != null) {
        pending.finish(screenRequestFailure('screen-pet-capture-failed'));
        sendJson(res, 200, { ok: true, accepted: false });
        return;
      }
      let image;
      try {
        image = parseScreenCapture(JSON.stringify(body), {
          maxBytes: SCREEN_FRAME_MAX_BYTES,
        });
      } catch (error) {
        pending.finish(screenRequestFailure(
          error?.code || 'screen-frame-invalid',
        ));
        sendJson(res, 400, { ok: false, error: 'screen-frame-invalid' });
        return;
      }
      pending.finish(null, image);
      sendJson(res, 200, { ok: true, accepted: true });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/screen') {
      if (!config.screenState || typeof config.screenState.setEnabled !== 'function') {
        sendJson(res, 503, { ok: false, error: 'screen-unavailable' });
        return;
      }
      const body = await readJsonBody(req);
      if (typeof body.enabled !== 'boolean') {
        sendJson(res, 400, { ok: false, error: 'bad-screen-enabled' });
        return;
      }
      try {
        const value = config.screenState.setEnabled(body.enabled, Date.now());
        if (value.persisted === false) {
          sendJson(res, 503, {
            ok: false,
            error: 'screen-permission-not-saved',
            value: screenPayload(),
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          value: screenPayload(),
        });
      } catch {
        sendJson(res, 503, { ok: false, error: 'screen-update-failed' });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/emotion/dashboard') {
      const service = emotion();
      if (!service || typeof service.dashboard !== 'function') {
        sendJson(res, 503, { ok: false, error: 'emotion-unavailable' });
        return;
      }
      try {
        const snapshot = await service.dashboard();
        sendJson(res, 200, { ok: true, value: snapshot });
      } catch (error) {
        const code = error && typeof error.code === 'string'
          ? error.code
          : 'emotion-dashboard-unavailable';
        sendJson(res, 503, { ok: false, error: code });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/sessions') {
      await restoreTask;
      try {
        // ?refresh=1 绕过 8 秒缓存（桌宠的刷新按钮用）
        const force = url.searchParams.get('refresh') === '1';
        const scope = normalizeSessionScope(url.searchParams.get('channel'));
        const sessions = sessionsForScope(await rootSessions({ force }), scope);
        sendJson(res, 200, {
          ok: true,
          scope,
          sessions,
          binding: bindingPayload(scope),
          bindings: allBindingPayloads(),
        });
      } catch (error) {
        log(`会话列表读取失败 code=${(error && (error.code || error.name)) || 'Error'}`);
        sendJson(res, 503, { ok: false, error: 'sessions-unavailable' });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/bind') {
      const body = await readJsonBody(req);
      const result = await bindSession(body.sessionId, normalizeChannel(body.channel));
      sendJson(res, result.status, result.body);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/unbind') {
      const body = await readJsonBody(req);
      const result = unbindSession(normalizeChannel(body.channel));
      sendJson(res, result.status, result.body);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      await restoreTask;
      const channel = normalizeChannel(url.searchParams.get('channel'));
      const bound = bindings[channel];
      if (!bound) {
        sendJson(res, 409, { ok: false, error: 'unbound', message: '请先绑定一个 DSH 会话' });
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');
      const bridgeFrame = {
        ok: true,
        connected: true,
        channel,
        dshVersion: dshVersion(),
        pid: process.pid,
        port: actualPort,
      };
      res.write(`event: bridge\ndata: ${JSON.stringify(bridgeFrame)}\n\n`);
      if (!hubs[channel]) startFollower(channel);
      const activeHub = hubs[channel];
      const client = activeHub
        ? activeHub.attach(res)
        : (() => {
            try {
              res.write(`event: snapshot\ndata: ${JSON.stringify({
                channel,
                sessionId: bound.sessionId,
                cursor: -1,
                phase: 'idle',
                turn: null,
                approval: null,
                binding: bindingPayload(channel),
                recent: [],
                emotion: channel === 'chat' ? coordinator.latestCue(bound.sessionId) : null,
              })}\n\n`);
            } catch {
              /* ignore */
            }
            return null;
          })();
      if (channel === 'chat' && client) proactive.wake(1000);
      if (!client) {
        // 保险：没有 hub 时至少保持心跳与关闭语义
        const timer = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            clearInterval(timer);
          }
        }, HEARTBEAT_MS);
        timer.unref?.();
        res.on('close', () => clearInterval(timer));
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/chat') {
      await restoreTask;
      const body = await readJsonBody(req);
      const controller = sc();
      if (!controller) {
        sendJson(res, 503, { ok: false, error: 'session-controller-unavailable' });
        return;
      }
      const channel = normalizeChannel(body.channel);
      const mode = body.mode === undefined ? 'queue' : String(body.mode);
      if (mode !== 'queue' && mode !== 'steer') {
        sendJson(res, 400, { ok: false, error: 'bad-mode' });
        return;
      }
      const text = String(body.text ?? '');
      if (text.trim() === '' || text.length > TEXT_LIMIT) {
        sendJson(res, 400, { ok: false, error: 'bad-text' });
        return;
      }
      const requestedSessionId = String(body.sessionId ?? '').trim();
      let sessionId = requestedSessionId || String(bindings[channel]?.sessionId ?? '').trim();
      if (
        channel === 'chat'
        && (
          !requestedSessionId
          || requestedSessionId === bindings.chat?.sessionId
        )
      ) {
        try {
          const created = await ensureCompanionBinding();
          sessionId = String(created?.sessionId || '');
        } catch (error) {
          const code = error && typeof error.code === 'string'
            ? error.code
            : 'companion-create-failed';
          sendJson(res, 503, { ok: false, error: code, channel });
          return;
        }
      }
      if (!sessionId) {
        sendJson(res, 409, { ok: false, error: 'unbound', channel });
        return;
      }
      const inspected = await inspectRootSession(sessionId);
      if (inspected.kind === 'unavailable') {
        sendJson(res, 503, { ok: false, error: 'session-inspection-unavailable', channel });
        return;
      }
      if (inspected.kind !== 'root') {
        sendJson(res, 404, { ok: false, error: 'session-not-found' });
        return;
      }
      if (channel === 'chat' && !isCompanionWorkspace(inspected.cwd)) {
        sendJson(res, 400, { ok: false, error: 'not-companion-workspace', channel });
        return;
      }
      if (
        channel === 'work'
        && (isCompanionWorkspace(inspected.cwd) || retiredChatSessionIds.has(sessionId))
      ) {
        sendJson(res, 400, { ok: false, error: 'not-work-workspace', channel });
        return;
      }
      const requestId = typeof body.requestId === 'string' && body.requestId.trim()
        ? body.requestId.trim()
        : randomUUID();
      if (channel === 'chat') {
        chatScreenIntent = hasExplicitVisualIntent(text)
          ? {
              sessionId,
              expiresAt: Date.now() + 120_000,
            }
          : null;
      }
      coordinator.setActivityContext(
        sessionId,
        channel === 'chat' ? body.activity : null,
        Date.now(),
      );
      const { signal, done } = abortAfter(20_000);
      try {
        await controller.prompt(
          {
            requestId,
            sessionId,
            mode,
            content: [{ type: 'text', text }],
            clientTimeZone: typeof body.clientTimeZone === 'string' ? body.clientTimeZone : undefined,
          },
          signal,
        );
      } catch (error) {
        done();
        if (
          channel === 'chat'
          && chatScreenIntent?.sessionId === sessionId
        ) {
          chatScreenIntent = null;
        }
        const code = error && typeof error.code === 'string' ? error.code : 'prompt-failed';
        sendJson(res, 502, { ok: false, error: code });
        return;
      }
      done();
      // 立刻 202，不等模型回复
      sendJson(res, 202, {
        ok: true,
        accepted: true,
        requestId,
        sessionId,
        channel,
        binding: bindingPayload(channel),
        bindings: allBindingPayloads(),
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/proactive') {
      await restoreTask;
      try {
        sendJson(res, 200, {
          ok: true,
          value: await proactive.status(),
        });
      } catch (error) {
        sendJson(res, 503, {
          ok: false,
          error: error?.code || 'proactive-unavailable',
        });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/proactive') {
      await restoreTask;
      const body = await readJsonBody(req);
      if (body.channel != null && String(body.channel) !== 'chat') {
        sendJson(res, 400, { ok: false, error: 'proactive-chat-only' });
        return;
      }
      try {
        const patch = body.settings && typeof body.settings === 'object'
          ? body.settings
          : body;
        sendJson(res, 200, {
          ok: true,
          value: await proactive.updateSettings(patch),
        });
      } catch (error) {
        sendJson(res, 503, {
          ok: false,
          error: error?.code || 'proactive-settings-failed',
        });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/proactive/presence') {
      const body = await readJsonBody(req);
      const now = Date.now();
      proactiveActivity = normalizeActivityContext(body.activity, { now });
      proactiveActivityAt = now;
      sendJson(res, 200, {
        ok: true,
        accepted: true,
        clientActive: proactiveClientActive(now),
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/cancel') {
      await restoreTask;
      const body = await readJsonBody(req);
      const controller = sc();
      if (!controller) {
        sendJson(res, 503, { ok: false, error: 'session-controller-unavailable' });
        return;
      }
      const channel = normalizeChannel(body.channel);
      const sessionId = String(body.sessionId ?? bindings[channel]?.sessionId ?? '').trim();
      if (!sessionId) {
        sendJson(res, 409, { ok: false, error: 'unbound', channel });
        return;
      }
      const inspected = await inspectRootSession(sessionId);
      if (inspected.kind === 'unavailable') {
        sendJson(res, 503, { ok: false, error: 'session-inspection-unavailable', channel });
        return;
      }
      if (inspected.kind !== 'root') {
        sendJson(res, 404, { ok: false, error: 'session-not-found' });
        return;
      }
      if (channel === 'chat' && !isCompanionWorkspace(inspected.cwd)) {
        sendJson(res, 400, { ok: false, error: 'not-companion-workspace', channel });
        return;
      }
      if (
        channel === 'work'
        && (isCompanionWorkspace(inspected.cwd) || retiredChatSessionIds.has(sessionId))
      ) {
        sendJson(res, 400, { ok: false, error: 'not-work-workspace', channel });
        return;
      }
      try {
        // 必须 await：真实实现目前是同步抛，但契约是可能返回 rejected Promise 的。
        await controller.cancel({ sessionId });
      } catch (error) {
        // 实测：cancel 只作用于「已挂载（live）」的会话；冷会话上抛 session/not-found。
        // 对桌宠来说「没有可取消的活轮次」不是错误，回 200 让它安静收敛。
        const code = error && typeof error.code === 'string' ? error.code : '';
        if (code === 'session/not-found' || /not attached/.test(String(error?.message ?? ''))) {
          sendJson(res, 200, { ok: true, accepted: false, reason: 'no-active-turn', sessionId, channel });
          return;
        }
        sendJson(res, 502, { ok: false, error: 'cancel-failed' });
        return;
      }
      sendJson(res, 200, { ok: true, accepted: true, sessionId, channel });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not-found' });
  }

  /* ---------- 监听 ---------- */

  function listen(port, fallbackOnBusy) {
    return new Promise((resolve, reject) => {
      const instance = http.createServer((req, res) => {
        handle(req, res).catch((error) => {
          const status = Number(error?.status) || 500;
          const code = typeof error?.code === 'string' ? error.code : 'internal';
          try {
            sendJson(res, status, { ok: false, error: code });
          } catch {
            /* 已经发过响应 */
          }
        });
      });
      instance.on('clientError', (_error, socket) => {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      });
      instance.once('error', (error) => {
        if (error && error.code === 'EADDRINUSE' && fallbackOnBusy) {
          // 固定端口被占：退到 OS 分配，绝不悄悄换别的固定端口
          log(`端口 ${port} 被占用，改用系统分配`);
          listen(0, false).then(resolve, reject);
          return;
        }
        reject(error);
      });
      instance.listen(port, config.bindHost, () => {
        const address = instance.address();
        resolve({ instance, port: typeof address === 'object' && address ? address.port : port });
      });
    });
  }

  const ready = (async () => {
    const started = await listen(config.port, true);
    server = started.instance;
    actualPort = started.port;
    writeJsonAtomic(dPaths.discovery, {
      schema: 1,
      host: config.bindHost,
      port: actualPort,
      pid: process.pid,
      startedAt,
      tokenFile: 'token',
      dshVersion: dshVersion(),
    });
    log(`listening on ${config.bindHost}:${actualPort} (pid ${process.pid})`);
    const current = readDiscovery(dPaths.discovery);
    if (current && current.pid === process.pid) log('发现文件已就绪');
  })().catch((error) => {
    log('启动失败', error && error.message ? error.message : String(error));
    throw error;
  });

  ctx.effect(() => async () => {
    await proactive.stop().catch(() => {});
    for (const channel of CHANNELS) {
      if (hubs[channel]) hubs[channel].stop('shutdown');
      hubs[channel] = null;
    }
    for (const pending of [...pendingScreenCaptures.values()]) {
      pending.finish(screenRequestFailure('screen-request-aborted'));
    }
    pendingScreenCaptures.clear();
    coordinator.close();
    if (server) {
      try {
        server.close();
      } catch {
        /* ignore */
      }
      server = null;
    }
    removeDiscoveryIfOwned(dPaths.discovery, process.pid);
    log('已卸载');
  });

  // 暴露给测试/其它插件的最小面（不含 token）
  ctx.provide?.(
    'fishpetBridge',
    Object.freeze({
      version: VERSION,
      get port() {
        return actualPort;
      },
      discoveryPath: dPaths.discovery,
      status: () => ({
        ok: true,
        port: actualPort,
        binding: bindingPayload('work'),
        bindings: allBindingPayloads(),
        companion: coordinator.status(),
        proactive: proactive.settings(),
      }),
      proactive: Object.freeze({
        status: () => proactive.status(),
        tick: () => proactive.tick(),
        wake: (delayMs = 0) => proactive.wake(delayMs),
      }),
      screen: Object.freeze({
        status: () => screenPayload(),
        setEnabled: (enabled) => (
          config.screenState && typeof config.screenState.setEnabled === 'function'
            ? config.screenState.setEnabled(enabled === true, Date.now())
            : null
        ),
      }),
      requestScreenCapture,
      latestChatActivity,
      ready,
    }),
  );
}
