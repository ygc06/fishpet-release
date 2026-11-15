/**
 * DSH FishPet 情绪系统插件入口。
 *
 * 目标：在 DSH 内提供结构化情绪判读、两层状态投影、后台生活和只读迁移预览。
 * 两层提交仍遵守同一 eventId 只处理一次、失败不半提交、预览只读且脱敏。
 *
 * 刻意不做的事：
 * - 不 import AstrBot、不调 Python、不起子进程、不主动联网；
 * - 不建 DSH 或宠物会话、不注册审批 answerer、不注册工具；
 * - 启动时不调模型、不迁移数据、不截屏；
 * - 不改桥接协议，也不碰 `app/**` 与 `bridge-plugin/**`。
 *
 * @module dsh-fishpet-emotion
 */

import os from 'node:os';
import path from 'node:path';

import { SERVICE_KEY } from './host/service.js';
import { createEmotionService } from './host/service.js';
import { registerDashboardRoute } from './host/dashboard-route.js';
import { createLlmJudgePort } from './judge/dsh-llm-port.js';
import { createDashboardHistory } from './dashboard/history.js';
import {
  createBackgroundScheduler,
  DEFAULT_BACKGROUND_INTERVAL_MS,
  MAX_BACKGROUND_INTERVAL_MS,
  MIN_BACKGROUND_INTERVAL_MS,
} from './life/scheduler.js';
import { createPresenceClock } from './life/presence.js';
import { createStore } from './store/index.js';

/** 插件名（DSH 插件清单里的 id）。 */
export const name = 'dsh-fishpet-emotion';

/** 插件版本，随 package.json 的 UI/Host 版本一起发布。 */
export const VERSION = '0.9.11';

/**
 * 看板路由走 DSH 自己的认证边界，因此硬依赖 `connection`。
 * 仍然不 inject `llm`：判读端口允许在缺少 llm 时降级为
 * `judge_unavailable`，而不是让整个插件不激活。
 */
export const inject = ['connection'];

/** 私有数据目录名（`$DSH_HOME` 下的第一级目录）。 */
export const DATA_DIR_NAME = 'fishpet-emotion';

/**
 * 展开 `~`、`~/`、`~\` 前缀。
 *
 * @param {string} value 原始路径。
 * @returns {string} 展开后的路径。
 */
function expandHome(value) {
  const text = String(value || '');
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(2));
  return text;
}

/**
 * 解析 DSH 家目录。
 *
 * 与 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome()` 同规则（显式配置 > `$DSH_HOME` > `~/.dsh`），
 * 这里自带一份三行实现是为了保持插件零运行时依赖；报告里记了上游接口的位置。
 *
 * @param {string} configured 显式配置的家目录。
 * @param {Record<string, string|undefined>} [env] 环境变量表。
 * @returns {string} 归一化后的绝对路径。
 */
export function resolveDshHome(configured, env = process.env) {
  const explicit = typeof configured === 'string' ? configured.trim() : '';
  if (explicit) return path.resolve(expandHome(explicit));
  const fromEnv = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (fromEnv) return path.resolve(expandHome(fromEnv));
  return path.join(os.homedir(), '.dsh');
}

/**
 * 合并配置默认值。
 *
 * @param {object} raw 插件宿主传入的原始配置。
 * @returns {object} 归一化配置。
 */
export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const judge = input.judge && typeof input.judge === 'object' ? input.judge : {};
  const background = input.background && typeof input.background === 'object'
    ? input.background
    : {};
  const configuredInterval = Number(background.intervalMs);
  return {
    dataDir: typeof input.dataDir === 'string' ? input.dataDir.trim() : '',
    homeDir: typeof input.homeDir === 'string' ? input.homeDir.trim() : '',
    legacyPreviewDir: typeof input.legacyPreviewDir === 'string' ? input.legacyPreviewDir.trim() : '',
    logBodies: input.logBodies === true,
    judge: {
      provider: typeof judge.provider === 'string' && judge.provider.trim()
        ? judge.provider.trim()
        : 'deepseek-official',
      model: typeof judge.model === 'string' && judge.model.trim()
        ? judge.model.trim()
        : 'deepseek-flash',
      reasoningEffort: typeof judge.reasoningEffort === 'string' && judge.reasoningEffort.trim()
        ? judge.reasoningEffort.trim()
        : 'low',
      timeoutMs: Number(judge.timeoutMs) > 0 ? Number(judge.timeoutMs) : 20000,
      retries: Number.isFinite(Number(judge.retries)) ? Math.max(0, Math.min(3, Number(judge.retries))) : 1,
      maxTokens: Number(judge.maxTokens) > 0 ? Number(judge.maxTokens) : 4096,
      temperature: Number.isFinite(Number(judge.temperature)) ? Number(judge.temperature) : 0.4,
      skipGreetings: judge.skipGreetings !== false,
      dailyCallLimit: Number.isFinite(Number(judge.dailyCallLimit))
        ? Math.max(0, Math.trunc(Number(judge.dailyCallLimit)))
        : 200,
      dailyTokenLimit: Number.isFinite(Number(judge.dailyTokenLimit))
        ? Math.max(0, Math.trunc(Number(judge.dailyTokenLimit)))
        : 200000,
      dailyCostLimit: Number.isFinite(Number(judge.dailyCostLimit))
        ? Math.max(0, Number(judge.dailyCostLimit))
        : 0,
      consecutiveFailureLimit: Number.isFinite(Number(judge.consecutiveFailureLimit))
        ? Math.max(0, Math.trunc(Number(judge.consecutiveFailureLimit)))
        : 5,
      circuitCooldownMs: Number.isFinite(Number(judge.circuitCooldownMs))
        ? Math.max(0, Math.trunc(Number(judge.circuitCooldownMs)))
        : 300000,
    },
    background: {
      enabled: background.enabled !== false,
      intervalMs: Number.isFinite(configuredInterval)
        ? Math.max(MIN_BACKGROUND_INTERVAL_MS, Math.min(MAX_BACKGROUND_INTERVAL_MS, configuredInterval))
        : DEFAULT_BACKGROUND_INTERVAL_MS,
      runOnStart: background.runOnStart === true,
      allowModel: background.allowModel === true,
    },
  };
}

/**
 * 解析私有数据目录：配置优先，否则 `$DSH_HOME/fishpet-emotion`。
 *
 * @param {object} config 归一化配置。
 * @param {Record<string, string|undefined>} [env] 环境变量表。
 * @returns {string} 绝对路径。
 */
export function resolveDataDir(config, env = process.env) {
  if (config.dataDir) return path.resolve(expandHome(config.dataDir));
  return path.join(resolveDshHome(config.homeDir, env), DATA_DIR_NAME);
}

/** 缓存 DSH 的消息构造器解析结果，避免每次判读都 import。 */
let messageFactoryPromise = null;

/**
 * 延迟解析 `@deepseek-ai/dsh-llm` 的 `createUserMessage`。
 *
 * 用动态 import 是为了：模块解析失败不会让插件加载失败，只让判读退回结构化消息对象。
 *
 * @returns {Promise<Function|null>} 构造函数或 null。
 */
function resolveMessageFactory() {
  if (!messageFactoryPromise) {
    messageFactoryPromise = import('@deepseek-ai/dsh-llm')
      .then((mod) => (typeof mod.createUserMessage === 'function' ? mod.createUserMessage : null))
      .catch(() => null);
  }
  return messageFactoryPromise;
}

/**
 * 插件入口。
 *
 * @param {object} ctx Cordis 上下文。
 * @param {object} [rawConfig] 插件配置。
 * @returns {object} 对外 API（同时通过 `ctx.provide` 暴露为 `fishpetEmotion`）。
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  const log = (line) => {
    try {
      // 只写脱敏摘要：不含消息正文、工具参数、token 或绝对路径。
      console.log(line);
    } catch {
      /* 日志通道异常不该影响插件 */
    }
  };

  const dataDir = resolveDataDir(config);
  const store = createStore({ dir: dataDir, log });
  const dashboardHistory = createDashboardHistory({ dir: dataDir, log });
  const state = {
    init: null,
    service: null,
    scheduler: null,
    presence: null,
    error: null,
  };
  let closing = false;

  const ready = (async () => {
    state.init = await store.init();
    try {
      const presence = createPresenceClock({ dir: dataDir, log });
      await presence.ready;
      state.presence = presence;
    } catch (error) {
      // 陪伴时钟是增强能力；坏文件或文件系统问题不能让情绪系统整体不可用。
      state.presence = null;
      log(`[emotion] presence init failed: ${(error && error.code) || (error && error.name) || 'Error'}`);
    }
    try {
      await dashboardHistory.init();
    } catch (error) {
      // 看板历史是旁路能力；坏文件只让看板降级，不让情绪系统进入只读。
      log(`[emotion] dashboard history init failed: ${(error && error.code) || (error && error.name) || 'Error'}`);
    }
    const port = createLlmJudgePort({ ctx, config, log, resolveMessageFactory });
    // 路由探测失败只代表"暂时没有判读能力"，不是插件故障：仍然要加载为 ready。
    // probe() 自己不会 reject，这里再兜一层，防止将来改动把它变成抛错。
    let probe = { available: false };
    try {
      probe = await port.probe();
    } catch (error) {
      log(`[emotion] probe failed: ${(error && error.name) || 'Error'}`);
    }
    if (!probe.available) {
      log('[emotion] judge unavailable: no llm route; state will stay untouched');
    }
    const service = createEmotionService({
      store,
      port,
      config,
      dataDir,
      init: state.init,
      log,
      dashboardHistory,
      pluginVersion: VERSION,
      presence: state.presence,
      getRuntime: () => ({
        presence: state.presence?.status?.() || { available: false },
        background: state.scheduler?.getStatus() || {
          started: false,
          stopped: closing,
          scheduled: false,
          intervalMs: config.background.intervalMs,
          allowModel: config.background.allowModel,
          ticks: 0,
          busy: false,
          lastCode: '',
          lastPassId: '',
        },
      }),
    });
    state.service = service;
    if (
      !closing
      && !state.init?.readonly
      && config.background.enabled
      && typeof ctx.effect === 'function'
    ) {
      try {
        state.scheduler = createBackgroundScheduler({
          service,
          intervalMs: config.background.intervalMs,
          runOnStart: config.background.runOnStart,
          allowModel: config.background.allowModel,
          log,
        });
        state.scheduler.start();
      } catch (error) {
        state.scheduler = null;
        log(`[emotion] background scheduler failed: ${(error && error.name) || 'Error'}`);
      }
    }
    log(`[emotion] ready ${service.summary()}`);
    return service;
  })().catch((error) => {
    state.error = error;
    log(`[emotion] init failed: ${(error && error.name) || 'Error'}`);
    // 排查用：只在显式打开调试开关时打首个栈帧，正常启动不会出现在日志里。
    if (process.env.DSH_EMOTION_DEBUG === '1') {
      const frame = String((error && error.stack) || '').split('\n').slice(0, 4).join(' | ');
      log(`[emotion] init stack: ${frame}`);
    }
    throw error;
  });
  // 允许失败被 await 的调用方观察到，同时避免未处理的 rejection 警告。
  ready.catch(() => {});

  registerDashboardRoute(ctx, {
    log,
    snapshot: async () => {
      const service = await ready;
      return service.dashboard();
    },
  });

  const api = {
    name,
    /** 判读并落账一条事件（同一 eventId 只成功一次）。 */
    async judge(envelope) {
      const service = await ready;
      return service.judge(envelope);
    },
    /**
     * 显式推进一次后台生活。默认干跑；同一个 `passId` 幂等。
     * 真要调用模型时必须同时传 `dryRun:false` 与 `allowModel:true`。
     */
    async background(options = {}) {
      const service = await ready;
      return service.background(options);
    },
    /** 脱敏状态摘要。 */
    async status() {
      try {
        const service = await ready;
        return service.status();
      } catch (error) {
        return {
          error: (error && error.message) || 'init-failed',
          readonly: true,
          llm: { available: false },
        };
      }
    },
    /** 完整只读看板快照（DSH 认证边界内）。 */
    async dashboard() {
      const service = await ready;
      return service.dashboard();
    },
    /**
     * 本轮陪伴时钟上下文。成功判读后由桥接层取一次，让模型知道真实离线/空闲时长。
     */
    async companionContext(input = {}) {
      const service = await ready;
      return service.companionContext(input);
    },
    /**
     * 确认上一份陪伴时钟预览已经进入模型上下文。
     */
    async acknowledgeCompanionContext(input = {}) {
      const service = await ready;
      return service.acknowledgeCompanionContext(input);
    },
    /** 主动开口门控使用的轻量陪伴时钟。 */
    async presenceSnapshot() {
      const service = await ready;
      return service.presenceSnapshot();
    },
    /** 主动开口前读取一次后台生活记录；不会改变已读状态。 */
    async proactiveContext() {
      const service = await ready;
      return service.proactiveContext();
    },
    /** 桥接层在助手回复生成后补写逐轮回放。 */
    async observeReply(input = {}) {
      const service = await ready;
      return service.observeReply(input);
    },
    /** 只读迁移预览。 */
    async preview(dir) {
      const service = await ready;
      return service.preview(dir || config.legacyPreviewDir);
    },
    /**
     * 预览后显式确认迁移。未带正确摘要、review 确认或身份映射时零写入。
     */
    async migrate(options = {}) {
      const service = await ready;
      return service.migrate({
        ...options,
        dir: options.dir || config.legacyPreviewDir,
      });
    },
    /** 卸载：取消在途判读并关闭存储。 */
    async close() {
      closing = true;
      const scheduler = state.scheduler;
      state.scheduler = null;
      try {
        await scheduler?.stop();
      } catch {
        /* 清理失败仍要继续关 store */
      }
      try {
        await state.presence?.close();
      } catch {
        /* 陪伴时钟是旁路记录，关不掉也不能阻止插件卸载 */
      }
      try {
        const service = await ready;
        await service.close();
      } catch {
        try {
          await store.close();
        } catch {
          /* 已经关了 */
        }
        try {
          await dashboardHistory.close();
        } catch {
          /* 已经关了 */
        }
      }
    },
    /** 存储目录（仅供测试与报告断言，不写进日志）。 */
    get dataDir() {
      return dataDir;
    },
    /** 就绪状态。 */
    get ready() {
      return Boolean(state.service);
    },
    get error() {
      return state.error;
    },
    get backgroundStatus() {
      return state.scheduler?.getStatus() || {
        started: false,
        stopped: closing,
        scheduled: false,
        intervalMs: config.background.intervalMs,
        allowModel: config.background.allowModel,
        ticks: 0,
        busy: false,
        lastCode: '',
        lastPassId: '',
      };
    },
  };

  if (typeof ctx.provide === 'function') ctx.provide(SERVICE_KEY, api);
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => async () => {
      await api.close().catch(() => {});
    });
  }

  return api;
}
