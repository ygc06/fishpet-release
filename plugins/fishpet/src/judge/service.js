/**
 * 判读服务：把「一次判读」变成「一次落账」。
 *
 * 负责（派工单 host 合同）：
 * - 显式超时 + 可取消，取消信号一路传给底层 stream；
 * - 同一 `eventId` 只落账一次（先查账本，重复直接返回，不再调模型）；
 * - 失败不应用部分状态；默认只允许一次有限重试；
 * - 稳定错误码 + 脱敏日志。
 *
 * 不负责：拼提示词、解析 JSON（在 port/contract 里），也不改桥接协议。
 *
 * @module dsh-fishpet-emotion/judge/service
 */

import { CHANNELS, JUDGE_ERRORS } from '../domain/enums.js';
import { checkEventId } from '../domain/event-id.js';
import { normalizeJudgeResult } from './contract.js';
import { crisisHit, crisisLine } from '../engine/safety.js';
import {
  applyJudgeResult,
  layer2View,
} from '../engine/apply.js';
import { buildRoundObservation } from '../dashboard/observation.js';
import {
  BUDGET_ERRORS,
  isStandaloneGreeting,
} from './budget.js';

/** 值得重试的失败码：都属于「这次没成功，再来一次可能成」。
 * `ABORTED` 不重试（调用方已经不要了），`AUTH`/`NO_ROUTE` 重试也没用。 */
const RETRYABLE = new Set([
  JUDGE_ERRORS.EMPTY,
  JUDGE_ERRORS.BAD_JSON,
  JUDGE_ERRORS.TIMEOUT,
  JUDGE_ERRORS.RATE_LIMIT,
  JUDGE_ERRORS.ALL_FIELDS_BAD,
]);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 校验判读信封的基本形状。
 *
 * 三条硬规则（都在调用模型、写盘之前）：
 * 1. `eventId` 必须过 `checkEventId()`——它会一路被写进纯文本索引，任何换行/控制字符/
 *    孤立 surrogate 都会在写入阶段炸掉事务（R2 派工单 P0-2）。
 * 2. `input` 必须是非数组对象。
 * 3. `input.utterance` 缺省当空串；存在时必须是字符串，否则原话核对会抛
 *    `utterance.includes is not a function`（R2 派工单 P0-3）。
 *
 * @param {object} envelope 待校验信封。
 * @returns {{ok: true, eventId: string, utterance: string} | {ok: false, code: string, reason: string}} 结果。
 */
export function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { ok: false, code: 'judge_bad_envelope', reason: 'not-object' };
  }
  const idCheck = checkEventId(envelope.eventId);
  if (!idCheck.ok) {
    // 缺 id / 不是字符串 / 只有空白 → 沿用旧口径 `eventId`；
    // 格式违规（换行、控制字符、超长、坏 surrogate）带具体原因，便于排错但不回显 id 本身。
    const generic = idCheck.reason === 'not-string' || idCheck.reason === 'empty';
    return { ok: false, code: 'judge_bad_envelope', reason: generic ? 'eventId' : 'eventId:' + idCheck.reason };
  }
  if (!CHANNELS.includes(envelope.channel)) {
    return { ok: false, code: 'judge_bad_envelope', reason: 'channel' };
  }
  const input = envelope.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'judge_bad_envelope', reason: 'input' };
  }
  const raw = input.utterance;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    return { ok: false, code: 'judge_bad_envelope', reason: 'utterance' };
  }
  return { ok: true, eventId: idCheck.id, utterance: typeof raw === 'string' ? raw : '' };
}

/**
 * 建一个带超时、可被外部取消的信号，并额外给出一条「到点」的 Promise。
 *
 * 为什么要有 `reached`：底层 provider 完全可能忽略 `AbortSignal`（不少适配器
 * 只是把 signal 转手一丢）。只靠 abort 的话，`await port.call()` 会一直挂着，
 * 服务侧的 `timeoutMs` 就成了摆设（R1 派工单 P0-4）。所以超时必须是**我这边
 * 主动判负**，而不是请求底层配合。
 *
 * @param {AbortSignal|undefined} outer 外部取消信号。
 * @param {number} timeoutMs 超时毫秒。
 * @returns {{signal: AbortSignal, timedOut: () => boolean, reached: Promise<{timedOut?: boolean, aborted?: boolean}>, dispose: () => void}} 句柄。
 */
export function withDeadline(outer, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let fire = () => {};
  const reached = new Promise((resolve) => { fire = resolve; });

  const timer = Number(timeoutMs) > 0
    ? setTimeout(() => {
      timedOut = true;
      controller.abort();
      fire({ timedOut: true });
    }, Number(timeoutMs))
    : null;
  if (timer && typeof timer.unref === 'function') timer.unref();

  const onAbort = () => {
    controller.abort();
    fire({ aborted: true });
  };
  if (outer) {
    if (outer.aborted) onAbort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    reached,
    dispose: () => {
      if (timer) clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * 一次带硬超时的调用。
 *
 * 三件事必须同时成立：到点就判负、迟到结果不落账、迟到 Promise 不产生未处理拒绝。
 *
 * @param {object} port 判读端口。
 * @param {object} envelope 信封。
 * @param {ReturnType<typeof withDeadline>} deadline 超时句柄。
 * @returns {Promise<{ok: boolean, code?: string, data?: object}>} 端口结果或超时结果。
 */
async function callWithDeadline(port, envelope, deadline) {
  const call = Promise.resolve()
    .then(() => port.call(envelope, deadline.signal))
    // 端口抛异常也当一次失败；迟到/落败的那一路同样走这里，不会变成未处理拒绝。
    .catch((error) => ({ ok: false, code: JUDGE_ERRORS.EMPTY, thrown: (error && error.name) || 'Error' }));
  const raced = await Promise.race([
    call,
    deadline.reached.then((info) => ({
      ok: false,
      code: info && info.timedOut ? JUDGE_ERRORS.TIMEOUT : JUDGE_ERRORS.ABORTED,
      deadline: true,
      // 到点时端口调用已经开始，哪怕 provider 忽略取消、最终没把结果还回来，
      // 也必须按一次真实尝试计入预算。按“未调用”退款会留下绕过每日上限的缺口。
      called: true,
    })),
  ]);
  return raced;
}

/**
 * 把一次成功判读投影到状态文件（只覆盖出现的字段）。
 *
 * 这是「层 1 的最小投影」：账本才是幂等权威，状态文件只是可读快照；
 * 投影失败不撤销账本行，只记一条降级。
 *
 * @param {object} state 当前状态。
 * @param {object} result 归一化后的判读结果。
 * @param {string} eventId 事件 id。
 * @param {number} now 当前毫秒。
 * @returns {object} 新状态（不修改入参）。
 */
export function projectState(state, result, eventId, now) {
  const next = { ...state };
  next.updatedAt = now;
  next.lastEventId = eventId;
  if (result.emo) next.emo = result.emo;
  if (Array.isArray(result.feelings) && result.feelings.length) next.feelings = result.feelings.slice(0, 4);
  if (result.mood) next.mood = result.mood;
  if (result.state) next.state = result.state;
  if (result.delta && Object.keys(result.delta).length) {
    const axes = { ...(state.axes || {}) };
    for (const [key, value] of Object.entries(result.delta)) {
      axes[key] = Number(axes[key] || 0) + Number(value || 0);
    }
    next.axes = axes;
  }
  return next;
}

/**
 * 创建判读服务。
 *
 * @param {object} options 选项。
 * @param {object} options.store `EmotionStore`。
 * @param {object} options.port LLM 判读端口（`createLlmJudgePort` 的返回值）。
 * @param {object} options.config 插件配置。
 * @param {(line: string) => void} [options.log] 脱敏日志。
 * @param {() => number} [options.clock] 时钟，测试可注入。
 * @param {() => number} [options.random] 随机源，测试可注入。
 * @param {(record: object) => Promise<void>|void} [options.observeRound] 纯观测钩子；不得影响判读结果。
 * @param {object|null} [options.budget] 判读调用预算/熔断器。
 * @returns {{judge: Function, stats: object}} 判读服务。
 */
export function createJudgeService({
  store,
  port,
  config,
  log = () => {},
  clock = () => Date.now(),
  random = () => 0.5,
  observeRound = null,
  budget = null,
}) {
  const judgeConfig = (config && config.judge) || {};
  const timeoutMs = Number(judgeConfig.timeoutMs) > 0 ? Number(judgeConfig.timeoutMs) : 20000;
  const retries = Number.isFinite(Number(judgeConfig.retries)) ? Math.max(0, Math.min(3, Number(judgeConfig.retries))) : 1;
  const stats = {
    judged: 0,
    failed: 0,
    duplicate: 0,
    retried: 0,
    crisis: 0,
    skippedGreeting: 0,
    budgetBlocked: 0,
  };
  /** 在途判读：同一个 eventId 只允许调一次模型（R1 派工单 P0-3）。 */
  const inflight = new Map();

  /**
   * 看板观测永远旁路执行。即使观测写盘失败，也不能改变判读的返回值或
   * 让已经成功提交的情绪被标成失败。
   */
  function notifyObservation(record) {
    if (typeof observeRound !== 'function' || !record) return;
    try {
      Promise.resolve(observeRound(record)).catch((error) => {
        log(`[emotion] dashboard observation failed: ${(error && error.code) || (error && error.name) || 'Error'}`);
      });
    } catch (error) {
      log(`[emotion] dashboard observation failed: ${(error && error.name) || 'Error'}`);
    }
  }

  function mergeModelUsage(total, usage) {
    const next = isObject(total) ? { ...total } : {};
    if (!isObject(usage)) return Object.keys(next).length ? next : null;
    for (const key of [
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'reasoningTokens',
    ]) {
      if (Number.isFinite(Number(usage[key]))) {
        next[key] = Number(next[key] || 0) + Number(usage[key]);
      }
    }
    return Object.keys(next).length ? next : null;
  }

  async function settleBudget(reservation, outcome) {
    if (!budget || !reservation || typeof budget.settle !== 'function') return;
    try {
      const settled = await budget.settle(reservation, outcome);
      if (settled && settled.ok === false) {
        log(`[emotion] judge budget settle failed: ${settled.code || 'judge_budget_unavailable'}`);
      }
    } catch (error) {
      log(`[emotion] judge budget settle failed: ${(error && error.code) || (error && error.name) || 'Error'}`);
    }
  }

  /**
   * 把一次成功判读落账并投影状态。
   *
   * 优先走 `store.commitJudge()`：它把「查重 → 投影 → 写状态 → 写账本」放进
   * 同一个存储临界区，并带意图日志，所以并发不会丢更新、写失败也不会假装成功
   * （R1 派工单 P0-2）。老 store 没有这个方法时退回顺序执行，但状态写失败同样是硬错误。
   *
   * @param {string} eventId 事件 id。
   * @param {object} record 账本行。
   * @param {object} result 归一化结果。
   * @param {number} now 当前毫秒。
   * @returns {Promise<{ok: boolean, duplicate?: boolean, code?: string}>} 落账结果。
   */
  async function commit(eventId, record, result, now, envelope) {
    try {
      if (typeof store.commitJudge === 'function') {
        let layer2Outcome = null;
        let layer2Before = null;
        let layer2After = null;
        const supportsLayer2 = typeof store.readLayer2 === 'function';
        const committed = await store.commitJudge({
          eventId,
          record,
          project: (current) => projectState(current, result, eventId, now),
          ...(supportsLayer2 ? {
            projectLayer2: (current) => {
              layer2Before = current;
              layer2Outcome = applyJudgeResult(current, result, envelope, { now, random });
              layer2After = layer2Outcome.state;
              return layer2Outcome.state;
            },
          } : {}),
        });
        if (committed.ok && layer2Outcome) {
          return {
            ...committed,
            context: layer2Outcome.context,
            view: layer2View(layer2Outcome.state, now),
            effects: layer2Outcome.effects,
            observationBefore: layer2Before,
            observationAfter: layer2After,
          };
        }
        return committed;
      }
      const appended = await store.appendEvent(record);
      if (!appended.ok && !appended.duplicate) return { ok: false, code: appended.code || 'ledger-write-failed' };
      if (appended.duplicate) return { ok: true, duplicate: true };
      const current = await store.readState();
      const saved = await store.saveState(projectState(current, result, eventId, now));
      if (saved && saved.ok === false) return { ok: false, code: saved.code || 'state-write-failed' };
      return { ok: true };
    } catch (error) {
      // 存储层抛异常也是「这次没落成」：给稳定码，别把异常甩给调用方。
      log(`[emotion] commit threw: ${(error && error.name) || 'Error'}`);
      return { ok: false, code: 'state-write-failed' };
    }
  }

  /**
   * 判读一条事件（带并发合并）。
   *
   * @param {object} envelope `JudgeEnvelopeV1`。
   * @param {AbortSignal} [signal] 外部取消信号。
   * @returns {Promise<object>} 结果。
   */
  async function judge(envelope, signal) {
    const shape = validateEnvelope(envelope);
    if (!shape.ok) {
      stats.failed += 1;
      return { ok: false, code: shape.code, reason: shape.reason, attempts: 0 };
    }
    const eventId = shape.eventId;
    const utterance = shape.utterance;

    // 同一个 eventId 已经在跑：等它，不再调一次模型。
    // 后到者拿到的是「明确的并发重复结果」——即使前一个成功了，后到者也不能再拿一个
    // ok:true，否则调用方会以为自己也落了一次账。
    const running = inflight.get(eventId);
    if (running) {
      const shared = await running;
      stats.duplicate += 1;
      if (shared && shared.ok) {
        return { ok: false, code: JUDGE_ERRORS.DUPLICATE, duplicate: true, concurrent: true, attempts: 0 };
      }
      return { ...shared, concurrent: true };
    }

    const task = runJudge(envelope, eventId, utterance, signal);
    const tracked = task.finally(() => {
      if (inflight.get(eventId) === tracked) inflight.delete(eventId);
    });
    inflight.set(eventId, tracked);
    return tracked;
  }

  /**
   * 真正的判读流程（不含并发合并）。
   *
   * @param {object} envelope 信封。
   * @param {string} eventId 已过合同校验的事件 id。
   * @param {string} utterance 已确认是字符串的原话（缺省为空串）。
   * @param {AbortSignal} [signal] 外部信号。
   * @returns {Promise<object>} 结果。
   */
  async function runJudge(envelope, eventId, utterance, signal) {
    let known = false;
    try {
      known = await store.hasEventId(eventId);
    } catch (error) {
      log(`[emotion] ledger read failed: ${error && error.name}`);
    }
    if (known) {
      stats.duplicate += 1;
      return { ok: false, code: JUDGE_ERRORS.DUPLICATE, duplicate: true, attempts: 0 };
    }

    // 安全线先于角色情绪：命中后不调判读模型、不写账、不动任何情绪状态。
    // 返回 ok:true 表示“这一轮已经有安全处理结果”，而不是一次情绪判读成功。
    if (crisisHit(utterance)) {
      stats.crisis += 1;
      notifyObservation(buildRoundObservation({
        envelope,
        rawResult: null,
        result: null,
        before: null,
        after: null,
        effects: null,
        now: clock(),
        attempts: 0,
        status: 'crisis',
        errorCode: '',
        crisis: true,
      }));
      return {
        ok: true,
        crisis: true,
        skipped: 'crisis',
        attempts: 0,
        context: [crisisLine(utterance)],
      };
    }

    // 独立寒暄不提供新的情绪证据。主聊天仍正常回复，只省掉一次判读模型调用。
    // 带实质内容的句子不会被这个窄规则命中。
    if (judgeConfig.skipGreetings !== false && isStandaloneGreeting(utterance)) {
      stats.skippedGreeting += 1;
      return {
        ok: true,
        skipped: 'greeting',
        attempts: 0,
      };
    }

    const totalAttempts = 1 + retries;
    let lastCode = JUDGE_ERRORS.EMPTY;
    let modelUsage = null;
    let attemptsMade = 0;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      if (signal && signal.aborted) {
        stats.failed += 1;
        return { ok: false, code: JUDGE_ERRORS.ABORTED, attempts: attempt - 1 };
      }
      let reservation = null;
      if (budget && typeof budget.reserve === 'function') {
        let reserved;
        try {
          reserved = await budget.reserve();
        } catch (error) {
          reserved = {
            ok: false,
            code: BUDGET_ERRORS.UNAVAILABLE,
            reason: (error && error.code) || 'budget-unavailable',
          };
        }
        if (!reserved || reserved.ok !== true) {
          stats.budgetBlocked += 1;
          lastCode = (reserved && reserved.code) || BUDGET_ERRORS.UNAVAILABLE;
          break;
        }
        reservation = reserved.permit;
      }
      attemptsMade = attempt;
      const deadline = withDeadline(signal, timeoutMs);
      let raw;
      try {
        raw = await callWithDeadline(port, envelope, deadline);
      } finally {
        deadline.dispose();
      }
      modelUsage = mergeModelUsage(modelUsage, raw?.usage);
      if (raw?.called === true) {
        modelUsage = { ...(modelUsage || {}), calls: Number(modelUsage?.calls || 0) + 1 };
      }

      if (!raw.ok) {
        lastCode = raw.code === JUDGE_ERRORS.ABORTED && deadline.timedOut() ? JUDGE_ERRORS.TIMEOUT : raw.code;
        await settleBudget(reservation, {
          called: raw.called === true,
          usage: raw.usage,
          result: lastCode === JUDGE_ERRORS.ABORTED ? 'neutral' : 'failure',
        });
      } else {
        // provider 可能给回任何东西（甚至是 `{utterance: {...}}` 那种错形状）。归一化
        // 里只要还有一处 `throw`，调用方就会拿到未捕获异常 —— 这里兜底成稳定失败码，
        // 保证「未捕获异常为零」（R2 派工单 P0-3）。
        let normalized;
        try {
          normalized = normalizeJudgeResult(raw.data, { utterance });
        } catch (error) {
          log(`[emotion] normalize threw: ${(error && error.name) || 'Error'}`);
          normalized = { ok: false, code: JUDGE_ERRORS.ALL_FIELDS_BAD, degraded: [] };
        }
        if (normalized.ok) {
          await settleBudget(reservation, {
            called: raw.called === true,
            usage: raw.usage,
            result: 'success',
          });
          const now = clock();
          const record = {
            schemaVersion: 1,
            eventId,
            at: now,
            channel: envelope.channel,
            act: normalized.result.act,
            emo: normalized.result.emo,
            delta: [
              Number(normalized.result.delta.valence || 0),
              Number(normalized.result.delta.arousal || 0),
              Number(normalized.result.delta.clingy || 0),
              Number(normalized.result.delta.dominance || 0),
            ],
            hash: hashResult(normalized.result),
          };
          const committed = await commit(eventId, record, normalized.result, now, envelope);
          if (!committed.ok) {
            stats.failed += 1;
            log(`[emotion] commit failed: ${committed.code}`);
            notifyObservation(buildRoundObservation({
              envelope,
              rawResult: raw.data,
              result: normalized.result,
              before: committed.observationBefore || null,
              after: committed.observationAfter || null,
              effects: committed.effects || null,
              now,
              attempts: attempt,
              status: 'failed',
              errorCode: committed.code || 'judge_commit_failed',
              modelUsage,
            }));
            return { ok: false, code: committed.code || 'judge_commit_failed', attempts: attempt };
          }
          if (committed.duplicate) {
            stats.duplicate += 1;
            return { ok: false, code: JUDGE_ERRORS.DUPLICATE, duplicate: true, attempts: attempt };
          }

          stats.judged += 1;
          if (attempt > 1) stats.retried += 1;
          try {
            // 一次成功判读只记一次：judged 必加，degraded 有降级才加。
            const patch = { judged: 1, lastJudgeAt: now };
            if (normalized.degraded.length) patch.degraded = 1;
            await store.bumpUsage(patch);
          } catch { /* 计数失败不影响本次判读 */ }
          notifyObservation(buildRoundObservation({
            envelope,
            rawResult: raw.data,
            result: normalized.result,
            before: committed.observationBefore || null,
            after: committed.observationAfter || null,
            effects: committed.effects || null,
            now,
            attempts: attempt,
            status: committed.effects && committed.effects.blocked ? 'blocked' : 'ok',
            errorCode: '',
            modelUsage,
          }));
          return {
            ok: true,
            result: normalized.result,
            attempts: attempt,
            degraded: normalized.degraded,
            ...(committed.context ? { context: committed.context } : {}),
            ...(committed.view ? { layer2: committed.view } : {}),
            ...(committed.effects ? { effects: committed.effects } : {}),
            ...(modelUsage ? { usage: modelUsage } : {}),
          };
        }
        lastCode = normalized.code || JUDGE_ERRORS.ALL_FIELDS_BAD;
        await settleBudget(reservation, {
          called: raw.called === true,
          usage: raw.usage,
          result: 'failure',
        });
      }

      const canRetry = attempt < totalAttempts && RETRYABLE.has(lastCode) && !(signal && signal.aborted);
      if (!canRetry) break;
      log(`[emotion] retrying judge (${lastCode}) attempt ${attempt + 1}/${totalAttempts}`);
    }

    stats.failed += 1;
    try {
      await store.bumpUsage({ failed: 1 });
    } catch { /* 计数失败不影响本次判读 */ }
    notifyObservation(buildRoundObservation({
      envelope,
      rawResult: null,
      result: null,
      before: null,
      after: null,
      effects: null,
      now: clock(),
      attempts: attemptsMade,
      status: 'failed',
      errorCode: lastCode,
      modelUsage,
    }));
    return {
      ok: false,
      code: lastCode,
      attempts: attemptsMade,
      ...(modelUsage ? { usage: modelUsage } : {}),
    };
  }

  async function budgetStatus() {
    if (!budget || typeof budget.status !== 'function') return null;
    try {
      return await budget.status();
    } catch {
      return { unavailable: true };
    }
  }

  return { judge, stats, retries, timeoutMs, budgetStatus };
}

/**
 * 结果内容哈希：只用于账本核对，不用于安全签名。
 *
 * @param {object} result 归一化结果。
 * @returns {string} 8 位十六进制前缀 + 长度。
 */
export function hashResult(result) {
  const text = JSON.stringify({
    delta: result.delta || {},
    feelings: result.feelings || [],
    emo: result.emo || '',
    act: result.act || '',
    mood: result.mood || '',
  });
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return `${hash.toString(16).padStart(8, '0')}-${text.length}`;
}
