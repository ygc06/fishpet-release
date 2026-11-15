/**
 * 判读模型的本地用量提醒与故障熔断。
 *
 * `reserve()` 在调用模型之前先原子占用一次额度并落盘；并发判读共用同一条
 * 写队列，保证计数准确。每日调用数、tokens 和费用上限只产生提醒，不阻断
 * 判读；预算文件损坏仍 fail-closed，连续模型失败仍进入短期冷却。
 *
 * 这里不保存对话正文、模型输出、密钥或绝对路径。
 *
 * @module dsh-fishpet-emotion/judge/budget
 */

import { readJson, writeJsonAtomic } from '../store/atomic-json.js';

export const JUDGE_BUDGET_FILE = 'judge-budget.json';
export const JUDGE_BUDGET_SCHEMA_VERSION = 1;

export const BUDGET_ERRORS = Object.freeze({
  // 旧版本把上限当错误。保留常量兼容旧调用方，但 reserve() 不再返回它。
  EXHAUSTED: 'judge_budget_exhausted',
  CIRCUIT_OPEN: 'judge_circuit_open',
  UNAVAILABLE: 'judge_budget_unavailable',
});

export const BUDGET_NOTICES = Object.freeze({
  LIMIT_REACHED: 'judge_budget_notice',
});

function finiteNonNegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function integerNonNegative(value, fallback) {
  const number = finiteNonNegative(value, fallback);
  return Math.max(0, Math.trunc(number));
}

function localDayKey(now) {
  const date = new Date(Number(now));
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function createDefaultState(now) {
  return {
    schemaVersion: JUDGE_BUDGET_SCHEMA_VERSION,
    day: localDayKey(now),
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: 0,
    currency: '',
    consecutiveFailures: 0,
    circuitOpenUntil: 0,
    updatedAt: Number(now) || 0,
  };
}

function normalizeState(raw, now) {
  const base = createDefaultState(now);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  return {
    ...base,
    day: typeof raw.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.day) ? raw.day : base.day,
    calls: integerNonNegative(raw.calls, 0),
    inputTokens: integerNonNegative(raw.inputTokens, 0),
    outputTokens: integerNonNegative(raw.outputTokens, 0),
    totalTokens: integerNonNegative(raw.totalTokens, 0),
    cost: finiteNonNegative(raw.cost, 0),
    currency: typeof raw.currency === 'string' ? raw.currency.slice(0, 8) : '',
    consecutiveFailures: integerNonNegative(raw.consecutiveFailures, 0),
    circuitOpenUntil: finiteNonNegative(raw.circuitOpenUntil, 0),
    updatedAt: finiteNonNegative(raw.updatedAt, Number(now) || 0),
  };
}

function rollDay(state, now) {
  const day = localDayKey(now);
  if (state.day === day) return false;
  Object.assign(state, {
    day,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: 0,
    currency: '',
  });
  return true;
}

function usageNumber(usage, key) {
  const number = Number(usage && usage[key]);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function reachedLimits(state, limits) {
  const warnings = [];
  if (limits.dailyCallLimit > 0 && state.calls >= limits.dailyCallLimit) {
    warnings.push({
      code: BUDGET_NOTICES.LIMIT_REACHED,
      reason: 'calls',
      used: state.calls,
      limit: limits.dailyCallLimit,
    });
  }
  if (limits.dailyTokenLimit > 0 && state.totalTokens >= limits.dailyTokenLimit) {
    warnings.push({
      code: BUDGET_NOTICES.LIMIT_REACHED,
      reason: 'tokens',
      used: state.totalTokens,
      limit: limits.dailyTokenLimit,
    });
  }
  if (limits.dailyCostLimit > 0 && state.cost >= limits.dailyCostLimit) {
    warnings.push({
      code: BUDGET_NOTICES.LIMIT_REACHED,
      reason: 'cost',
      used: state.cost,
      limit: limits.dailyCostLimit,
    });
  }
  return warnings;
}

function publicSnapshot(state, limits, now) {
  const warnings = reachedLimits(state, limits);
  return {
    day: state.day,
    calls: state.calls,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    totalTokens: state.totalTokens,
    cost: state.cost,
    currency: state.currency,
    consecutiveFailures: state.consecutiveFailures,
    circuitOpenUntil: state.circuitOpenUntil,
    circuitOpen: state.circuitOpenUntil > Number(now),
    limitMode: 'remind',
    overLimit: warnings.length > 0,
    warnings,
    warning: warnings[0] || null,
    limits,
  };
}

/**
 * 判断是否为可以跳过判读的独立寒暄。
 *
 * 只在整句就是寒暄时返回 true。“你好，我很难受”“晚安，我有点害怕”
 * 这类包含实质内容的句子仍然必须判读。
 *
 * @param {unknown} value 当前原话。
 * @returns {boolean}
 */
export function isStandaloneGreeting(value) {
  let text = String(value == null ? '' : value).trim().toLowerCase();
  if (!text || text.length > 24) return false;
  text = text
    .replace(/[\s~～!！?？。,.，、…:：;；]+$/g, '')
    .replace(/[呀啊哦哈呐呢啦]+$/g, '');
  if (!text) return false;
  return /^(?:在吗|在不在|你在吗|你好|您好|嗨+|哈喽|hello|hi+|hey|早上好|早安|下午好|晚上好|晚安|早)$/i.test(text);
}

/**
 * 创建预算器。
 *
 * @param {object} options
 * @param {string} options.file 预算 JSON 文件。
 * @param {object} [options.config] judge 配置。
 * @param {() => number} [options.clock]
 * @param {(line: string) => void} [options.log]
 * @param {object} [options.fs] 测试用 fs。
 * @returns {object}
 */
export function createJudgeBudget({
  file,
  config = {},
  clock = () => Date.now(),
  log = () => {},
  fs,
} = {}) {
  if (typeof file !== 'string' || !file.trim()) throw new TypeError('budget file required');
  const limits = Object.freeze({
    dailyCallLimit: integerNonNegative(config.dailyCallLimit, 200),
    dailyTokenLimit: integerNonNegative(config.dailyTokenLimit, 200000),
    dailyCostLimit: finiteNonNegative(config.dailyCostLimit, 0),
    consecutiveFailureLimit: integerNonNegative(config.consecutiveFailureLimit, 5),
    circuitCooldownMs: integerNonNegative(config.circuitCooldownMs, 300000),
  });
  let state = null;
  let loadPromise = null;
  let chain = Promise.resolve();
  let permitSequence = 0;
  const reservations = new Map();
  const options = fs ? { fs } : undefined;

  const safeLog = (line) => {
    try {
      log(line);
    } catch {
      /* ignore */
    }
  };

  function enqueue(task) {
    const run = chain.then(task, task);
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async function persist() {
    const result = await writeJsonAtomic(file, state, options);
    if (!result || result.ok !== true) {
      throw Object.assign(new Error('budget-write-failed'), { code: 'budget-write-failed' });
    }
  }

  async function ensureLoaded() {
    if (state) return state;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const now = Number(clock());
      const read = await readJson(file, options);
      if (read.missing) {
        state = createDefaultState(now);
        await persist();
        return state;
      }
      if (!read.ok) {
        throw Object.assign(new Error('budget-file-corrupt'), { code: 'budget-file-corrupt' });
      }
      if (
        read.value
        && typeof read.value === 'object'
        && !Array.isArray(read.value)
        && read.value.schemaVersion !== JUDGE_BUDGET_SCHEMA_VERSION
      ) {
        throw Object.assign(new Error('budget-schema-mismatch'), { code: 'budget-schema-mismatch' });
      }
      state = normalizeState(read.value, now);
      if (rollDay(state, now)) await persist();
      return state;
    })();
    try {
      return await loadPromise;
    } catch (error) {
      loadPromise = null;
      safeLog(`[emotion] judge budget unavailable: ${(error && error.code) || 'Error'}`);
      throw error;
    }
  }

  function unavailable(error) {
    return {
      ok: false,
      code: BUDGET_ERRORS.UNAVAILABLE,
      reason: String((error && error.code) || 'budget-unavailable'),
      attempts: 0,
    };
  }

  async function reserve() {
    return enqueue(async () => {
      const now = Number(clock());
      try {
        await ensureLoaded();
        if (rollDay(state, now)) await persist();
      } catch (error) {
        return unavailable(error);
      }

      if (state.circuitOpenUntil > now) {
        return {
          ok: false,
          code: BUDGET_ERRORS.CIRCUIT_OPEN,
          reason: 'circuit-open',
          retryAt: state.circuitOpenUntil,
          status: publicSnapshot(state, limits, now),
        };
      }
      const previousCalls = state.calls;
      state.calls += 1;
      state.updatedAt = now;
      try {
        await persist();
      } catch (error) {
        state.calls = previousCalls;
        return unavailable(error);
      }
      const id = `permit-${now}-${++permitSequence}`;
      reservations.set(id, { day: state.day, at: now });
      return {
        ok: true,
        permit: { id },
        status: publicSnapshot(state, limits, now),
      };
    });
  }

  /**
   * @param {{id?: string}|null} permit reserve() 返回的 permit。
   * @param {{called?: boolean, usage?: object, result?: 'success'|'failure'|'neutral'}} outcome
   */
  async function settle(permit, outcome = {}) {
    if (!permit || typeof permit.id !== 'string') return { ok: true };
    return enqueue(async () => {
      const reserved = reservations.get(permit.id);
      if (!reserved) return { ok: true };
      reservations.delete(permit.id);
      const now = Number(clock());
      try {
        await ensureLoaded();
      } catch (error) {
        return unavailable(error);
      }

      // 跨午夜的在途请求只在原预约日占用一次；不把昨天的调用混进今天。
      if (state.day === reserved.day) {
        if (outcome.called !== true) state.calls = Math.max(0, state.calls - 1);
        const usage = outcome.usage && typeof outcome.usage === 'object' ? outcome.usage : {};
        const input = usageNumber(usage, 'inputTokens');
        const output = usageNumber(usage, 'outputTokens');
        const total = usageNumber(usage, 'totalTokens') || input + output;
        state.inputTokens += input;
        state.outputTokens += output;
        state.totalTokens += total;
        state.cost += usageNumber(usage, 'cost');
        if (!state.currency && typeof usage.currency === 'string' && usage.currency) {
          state.currency = usage.currency.slice(0, 8);
        }

        if (outcome.result === 'success') {
          state.consecutiveFailures = 0;
          state.circuitOpenUntil = 0;
        } else if (outcome.result === 'failure') {
          state.consecutiveFailures += 1;
          if (
            limits.consecutiveFailureLimit > 0
            && state.consecutiveFailures >= limits.consecutiveFailureLimit
          ) {
            state.circuitOpenUntil = now + limits.circuitCooldownMs;
          }
        }
      }
      state.updatedAt = now;
      try {
        await persist();
      } catch (error) {
        return unavailable(error);
      }
      return { ok: true, status: publicSnapshot(state, limits, now) };
    });
  }

  async function status() {
    return enqueue(async () => {
      const now = Number(clock());
      try {
        await ensureLoaded();
        if (rollDay(state, now)) await persist();
        return publicSnapshot(state, limits, now);
      } catch {
        return {
          ...publicSnapshot(createDefaultState(now), limits, now),
          unavailable: true,
        };
      }
    });
  }

  return {
    file,
    limits,
    reserve,
    settle,
    status,
    isStandaloneGreeting,
  };
}
