/**
 * DSH LLM 适配器：把 `ctx.llm` 包装成一次结构化判读。
 *
 * 职责边界（派工单 host 合同）：只负责选 provider/model、组织一次 stream、
 * 拼 `text-delta`、提取 JSON、超时与取消、把失败变成稳定错误码。
 * 业务校验、限幅、落账都在 `service.js` / `contract.js` 里，不进这里。
 *
 * @module dsh-fishpet-emotion/judge/dsh-llm-port
 */

import { JUDGE_ERRORS } from '../domain/enums.js';
import { extractJsonObject } from './contract.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';

/**
 * 把底层异常映射成稳定错误码。
 *
 * @param {unknown} error 捕获到的错误。
 * @returns {string} `JUDGE_ERRORS` 里的码。
 */
export function mapLlmError(error) {
  const code = String((error && (error.code || error.cause?.code)) || '');
  const message = String((error && error.message) || '').toLowerCase();
  if (code === 'AUTH' || message.includes('api key') || message.includes('unauthorized')) return JUDGE_ERRORS.AUTH;
  if (code === 'RATE_LIMIT' || message.includes('rate limit') || message.includes('429')) return JUDGE_ERRORS.RATE_LIMIT;
  if (code === 'NO_ADAPTER' || message.includes('no adapter')) return JUDGE_ERRORS.NO_ROUTE;
  if (error && (error.name === 'AbortError' || code === 'ABORT_ERR')) return JUDGE_ERRORS.ABORTED;
  return JUDGE_ERRORS.EMPTY;
}

/**
 * 组装一条 user 消息。
 *
 * 优先用 DSH 自己的 `createUserMessage`（消息需要稳定 id 与 source 归属）；
 * 该包不可解析时退回等价的结构化对象，并在启动摘要里标明用的是哪种。
 *
 * @param {object} options 选项。
 * @param {string} options.text 消息正文。
 * @param {Function|null} options.createUserMessage `@deepseek-ai/dsh-llm` 的构造函数。
 * @param {string} options.plugin 插件名，写入 `source.plugin`。
 * @returns {object} 一条 user 消息。
 */
export function makeUserMessage({ text, createUserMessage, plugin }) {
  if (typeof createUserMessage === 'function') {
    return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin } });
  }
  return {
    id: `msg-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin },
  };
}

/**
 * 创建判读端口。
 *
 * @param {object} options 选项。
 * @param {object} options.ctx Cordis 上下文（需要有 `llm` 服务）。
 * @param {object} options.config 已合并的插件配置。
 * @param {(line: string) => void} [options.log] 日志函数；只允许脱敏内容。
 * @param {Function|null} [options.createUserMessage] DSH 的消息构造函数。
 * @param {(() => Promise<Function|null>)|null} [options.resolveMessageFactory] 延迟解析构造函数（模块加载不阻塞 apply）。
 * @returns {{available: boolean, route: object, reason: string, call: Function}} 端口。
 */
export function createLlmJudgePort({ ctx, config, log, createUserMessage = null, resolveMessageFactory = null }) {
  const plugin = 'dsh-fishpet-emotion';
  const judgeConfig = (config && config.judge) || {};
  const state = {
    available: false,
    route: { provider: '', model: '', source: 'none' },
    reason: JUDGE_ERRORS.NO_ROUTE,
  };

  const llm = () => (ctx && (typeof ctx.get === 'function' ? ctx.get('llm') : null)) || (ctx && ctx.llm) || null;

  /**
   * 解析模型路由：显式配置优先，其次按 provider/model 列表选第一个可用。
   *
   * 只读元数据，不发请求、不读凭据文件。
   *
   * @returns {{provider: string, model: string, source: string}} 路由。
   */
  /**
   * 把 listModels() 的返回值收敛成数组。
   *
   * 真实 LlmRuntime.listModels() 是异步的，测试替身可能给同步数组，
   * 也可能给 {models: [...]} 这种包装；三种都接受，其余一律当空。
   */
  function toModelArray(value) {
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.models)) return value.models;
    if (value && typeof value !== 'string' && typeof value[Symbol.iterator] === 'function') {
      try {
        return Array.from(value);
      } catch {
        return [];
      }
    }
    return [];
  }

  async function listModelsOf(service, id) {
    if (typeof service.listModels !== 'function') return [];
    try {
      const raw = service.listModels(id);
      const resolved = raw && typeof raw.then === 'function' ? await raw : raw;
      return toModelArray(resolved);
    } catch {
      return [];
    }
  }

  /**
   * 把 listProviders() 的返回值收敛成数组。
   *
   * 真实实现返回数组，但测试替身/未来版本可能给 Promise 外的包装（`{providers:[...]}`）
   * 或干脆给个畸形对象；这些一律当"没有 provider"，不抛。
   */
  function toProviderArray(value) {
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.providers)) return value.providers;
    if (value && typeof value !== 'string' && typeof value[Symbol.iterator] === 'function') {
      try {
        return Array.from(value);
      } catch {
        return [];
      }
    }
    return [];
  }

  async function resolveRoute() {
    const provider = String(judgeConfig.provider || '').trim();
    const model = String(judgeConfig.model || '').trim();
    if (provider && model) return { provider, model, source: 'explicit' };

    const service = llm();
    if (!service || typeof service.listProviders !== 'function') {
      return { provider: '', model: '', source: 'none' };
    }
    // listProviders 可能同步抛错（服务半初始化），也可能返回 Promise；两种都在这里收口。
    const raw = service.listProviders();
    const providers = toProviderArray(raw && typeof raw.then === 'function' ? await raw : raw);
    for (const info of providers) {
      const id = typeof info === 'string' ? info : info && (info.id || info.provider);
      if (!id || (provider && id !== provider)) continue;
      const models = await listModelsOf(service, id);
      const first = models.map((m) => (typeof m === 'string' ? m : m && m.id)).find(Boolean);
      if (first) return { provider: id, model: model || first, source: provider ? 'provider+first-model' : 'first-available' };
    }
    return { provider: '', model: '', source: 'none' };
  }

  /**
   * 探测一次路由是否可用（启动时调用，不发请求）。
   *
   * **绝不 reject**：LLM 服务缺失、`listProviders` 抛错、返回畸形、`listModels` 异常、
   * 路由解析异常，一律收敛成 `available:false` + `judge_unavailable`。
   * 调用方（`host/service.js`、`call()`）因此不需要 try/catch 也能拿到稳定结果。
   *
   * @returns {Promise<{available: boolean, route: object, reason: string}>} 探测结果。
   */
  async function probe() {
    try {
      const service = llm();
      if (!service || typeof service.stream !== 'function') {
        state.available = false;
        state.reason = JUDGE_ERRORS.NO_ROUTE;
        state.route = { provider: '', model: '', source: 'none' };
        return { available: state.available, route: state.route, reason: state.reason };
      }
      const route = await resolveRoute();
      const valid = route && typeof route === 'object' && typeof route.provider === 'string' && typeof route.model === 'string';
      state.route = valid ? { provider: route.provider, model: route.model, source: String(route.source || 'none') } : { provider: '', model: '', source: 'none' };
      state.available = Boolean(state.route.provider && state.route.model);
      state.reason = state.available ? '' : JUDGE_ERRORS.NO_ROUTE;
    } catch (error) {
      // 路由发现失败 = 暂时没有可用判读能力，不是插件故障。
      state.available = false;
      state.reason = JUDGE_ERRORS.NO_ROUTE;
      state.route = { provider: '', model: '', source: 'none' };
      try {
        log('[emotion] llm probe failed: ' + ((error && error.name) || 'Error'));
      } catch {
        /* 日志器抛错不能影响判读结果 */
      }
    }
    return { available: state.available, route: state.route, reason: state.reason };
  }

  /**
   * 跑一次判读调用，返回解析后的对象。
   *
   * @param {object} envelope `JudgeEnvelopeV1`。
   * @param {AbortSignal} signal 取消信号（已含超时）。
   * @returns {Promise<{ok: boolean, data?: object, code?: string}>} 结果。
   */
  async function call(envelope, signal) {
    try {
      const service = llm();
      if (!service || typeof service.stream !== 'function') {
        return { ok: false, code: JUDGE_ERRORS.NO_ROUTE };
      }
      if (!state.available) {
        // 必须 await：以前这里漏了 await，probe 失败会变成未处理的 Promise 拒绝。
        // probe() 自己不会 reject，但这里再兜一层，保证 call() 永远只返回稳定码。
        try {
          await probe();
        } catch {
          state.available = false;
          state.reason = JUDGE_ERRORS.NO_ROUTE;
        }
      }
      if (!state.available) return { ok: false, code: JUDGE_ERRORS.NO_ROUTE };

      let factory = createUserMessage;
      if (!factory && resolveMessageFactory) {
        try {
          factory = await resolveMessageFactory();
        } catch {
          factory = null;
        }
      }

      const options = {
        provider: state.route.provider,
        model: state.route.model,
        system: buildSystemPrompt(),
        messages: [makeUserMessage({
          text: buildUserPrompt(envelope),
          createUserMessage: factory,
          plugin,
        })],
        // 判读是多字段 JSON，1024 在较新鲜或较长的对话上会被截断；截断后的
        // 半个对象无法修复，还会连续触发熔断。保留足够额度给完整对象输出。
        maxTokens: Number(judgeConfig.maxTokens) > 0 ? Number(judgeConfig.maxTokens) : 4096,
        temperature: Number.isFinite(Number(judgeConfig.temperature)) ? Number(judgeConfig.temperature) : 0.4,
        // 观察员只需要提取短而稳定的结构化事实。显式传低档，不再依赖
        // profile 默认值，也不让新会话继承聊天框里较高的思考档位。
        reasoningEffort: String(judgeConfig.reasoningEffort || 'low'),
        signal,
      };

      let text = '';
      let usage = null;
      let called = false;
      try {
        called = true;
        for await (const chunk of service.stream(options)) {
          if (signal && signal.aborted) {
            return { ok: false, code: JUDGE_ERRORS.ABORTED, called };
          }
          if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
          if (chunk && chunk.type === 'usage' && chunk.usage && typeof chunk.usage === 'object') {
            usage = { ...chunk.usage };
          }
        }
      } catch (error) {
        return {
          ok: false,
          code: mapLlmError(error),
          called,
          ...(usage ? { usage } : {}),
        };
      }

      if (!String(text).trim()) {
        return {
          ok: false,
          code: JUDGE_ERRORS.EMPTY,
          called,
          ...(usage ? { usage } : {}),
        };
      }
      const extracted = extractJsonObject(text);
      if (!extracted.ok) {
        return {
          ok: false,
          code: extracted.code,
          called,
          ...(usage ? { usage } : {}),
        };
      }
      return {
        ok: true,
        data: extracted.value,
        called,
        ...(usage ? { usage } : {}),
      };
    } catch (error) {
      // `ctx.get('llm')`、消息构造或任何未预料的服务调用异常都必须在端口内收口。
      state.available = false;
      state.reason = JUDGE_ERRORS.NO_ROUTE;
      state.route = { provider: '', model: '', source: 'none' };
      try {
        log('[emotion] llm call failed: ' + ((error && error.name) || 'Error'));
      } catch {
        /* 日志器抛错不能影响稳定返回 */
      }
      return { ok: false, code: JUDGE_ERRORS.NO_ROUTE };
    }
  }

  /**
   * 跑一次普通文本调用，供后台生活等非判读用途使用。
   *
   * 路由、取消和错误码与判读端口共用；这里不解析 JSON，也不替调用方
   * 判断内容是否符合业务合同。没有路由时返回稳定错误，不伪造文本。
   *
   * @param {{system: string, user: string, signal?: AbortSignal, maxTokens?: number, temperature?: number}} request
   * @returns {Promise<{ok: boolean, text?: string, code?: string}>}
   */
  async function callText(request = {}) {
    try {
      const service = llm();
      if (!service || typeof service.stream !== 'function') return { ok: false, code: JUDGE_ERRORS.NO_ROUTE };
      if (!state.available) {
        try {
          await probe();
        } catch {
          state.available = false;
        }
      }
      if (!state.available) return { ok: false, code: JUDGE_ERRORS.NO_ROUTE };

      let factory = createUserMessage;
      if (!factory && resolveMessageFactory) {
        try {
          factory = await resolveMessageFactory();
        } catch {
          factory = null;
        }
      }
      const signal = request.signal;
      const options = {
        provider: state.route.provider,
        model: state.route.model,
        system: String(request.system || ''),
        messages: [makeUserMessage({
          text: String(request.user || ''),
          createUserMessage: factory,
          plugin,
        })],
        maxTokens: Number(request.maxTokens) > 0 ? Number(request.maxTokens) : 512,
        temperature: Number.isFinite(Number(request.temperature)) ? Number(request.temperature) : 0.7,
        reasoningEffort: String(judgeConfig.reasoningEffort || 'low'),
        signal,
      };

      let text = '';
      try {
        for await (const chunk of service.stream(options)) {
          if (signal && signal.aborted) return { ok: false, code: JUDGE_ERRORS.ABORTED };
          if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
        }
      } catch (error) {
        return { ok: false, code: mapLlmError(error) };
      }
      if (!String(text).trim()) return { ok: false, code: JUDGE_ERRORS.EMPTY };
      return { ok: true, text };
    } catch (error) {
      state.available = false;
      state.reason = JUDGE_ERRORS.NO_ROUTE;
      state.route = { provider: '', model: '', source: 'none' };
      try {
        log('[emotion] llm text call failed: ' + ((error && error.name) || 'Error'));
      } catch {
        /* ignore */
      }
      return { ok: false, code: JUDGE_ERRORS.NO_ROUTE };
    }
  }

  return {
    probe,
    call,
    callText,
    get available() {
      return state.available;
    },
    get route() {
      return state.route;
    },
    get reason() {
      return state.reason;
    },
    /** 便于启动摘要显示：用的是不是 DSH 自己的消息构造器。 */
    messageFactory: typeof createUserMessage === 'function' ? 'dsh-llm.createUserMessage' : 'structural',
    /** 供日志使用：只暴露模型身份，不暴露密钥或请求体。 */
    describe() {
      return {
        available: state.available,
        provider: state.route.provider,
        model: state.route.model,
        source: state.route.source,
        reason: state.reason,
        messageFactory: typeof createUserMessage === 'function' ? 'dsh-llm.createUserMessage' : 'structural',
        logBodies: Boolean(config && config.logBodies),
      };
    },
    log,
  };
}
