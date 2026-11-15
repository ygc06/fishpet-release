/**
 * 插件对外的内部服务：把 store / port / judge 组装成一个小 API。
 *
 * 提供判读、两层状态查询、显式后台生活和只读迁移预览。
 * 不注册工具、不注册审批 answerer、不建会话、不发网络请求。
 *
 * @module dsh-fishpet-emotion/host/service
 */

import path from 'node:path';

import { JUDGE_ERRORS, JUDGE_UNAVAILABLE_PHASE } from '../domain/enums.js';
import { checkEventId } from '../domain/event-id.js';
import { previewLegacy } from '../store/migration-preview.js';
import {
  prepareLegacyMigration,
  writeMigrationArtifacts,
} from '../store/legacy-migrate.js';
import { createJudgeService } from '../judge/service.js';
import { createJudgeBudget, JUDGE_BUDGET_FILE } from '../judge/budget.js';
import { buildJudgeStateSnapshot } from '../judge/snapshot.js';
import { layer2View, runLayer2Background } from '../engine/apply.js';
import { crisisHit } from '../engine/safety.js';
import { buildRoundObservation } from '../dashboard/observation.js';
import { buildDashboardProjection } from '../dashboard/projection.js';
import { humanizeAssistantVoice } from '../bridge/lib/reduce.js';
import { backgroundLine } from '../life/background.js';

/** 服务对外暴露的名字，同时也是 `ctx.get()` 的键。 */
export const SERVICE_KEY = 'fishpetEmotion';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 组装内部服务。
 *
 * @param {object} options 选项。
 * @param {object} options.store `EmotionStore`。
 * @param {object} options.port LLM 判读端口。
 * @param {object} options.config 插件配置。
 * @param {string} options.dataDir 私有数据目录（绝对路径）。
 * @param {object} options.init `store.init()` 的结果。
 * @param {(line: string) => void} [options.log] 脱敏日志。
 * @param {() => number} [options.clock] 时钟，测试可注入。
 * @param {() => number} [options.random] 随机源，测试可注入。
 * @param {object|null} [options.dashboardHistory] 看板纯观测历史。
 * @param {() => object} [options.getRuntime] 插件运行时状态。
 * @param {string} [options.pluginVersion] 插件版本。
 * @param {object|null} [options.presence] 独立的陪伴时钟。
 * @returns {object} 内部服务。
 */
export function createEmotionService({
  store,
  port,
  config,
  dataDir,
  init,
  log = () => {},
  clock = () => Date.now(),
  random = () => 0.5,
  dashboardHistory = null,
  getRuntime = () => ({}),
  pluginVersion = '',
  presence = null,
}) {
  const judgeBudget = dataDir
    ? createJudgeBudget({
        file: path.join(dataDir, JUDGE_BUDGET_FILE),
        config: config && config.judge,
        clock,
        log,
      })
    : null;
  const judgeService = createJudgeService({
    store,
    port,
    config,
    log,
    clock,
    random,
    budget: judgeBudget,
    observeRound: dashboardHistory && typeof dashboardHistory.record === 'function'
      ? (record) => dashboardHistory.record(record)
      : null,
  });
  const inflight = new Set();
  let closed = false;

  /**
   * 判读并落账一条事件。
   *
   * @param {object} envelope `JudgeEnvelopeV1`。
   * @returns {Promise<object>} 判读结果（成功带 `result`，失败带稳定 `code`）。
   */
  async function judge(envelope) {
    if (closed) return { ok: false, code: 'emotion_closed', attempts: 0 };
    try {
      await presence?.touchInteraction?.({
        at: clock(),
        eventId: envelope?.eventId,
        channel: envelope?.channel,
      });
    } catch (error) {
      // 陪伴时钟不能阻断真正的聊天/判读链路。
      log(`[emotion] presence touch failed: ${(error && error.code) || (error && error.name) || 'Error'}`);
    }
    const controller = new AbortController();
    inflight.add(controller);
    try {
      if (!port.available) {
        // llm 可能是后挂载的：判读前再探一次路由，别让「加载早于 llm」变成永久不可用。
        // probe 在 try 里：探测本身抛错也要变成稳定结果，不能让异常穿过 Host API（R3 P0-1）。
        try {
          await port.probe();
        } catch (error) {
          log(`[emotion] probe failed: ${(error && error.name) || 'Error'}`);
        }
        if (!port.available) {
          // 安全线不依赖模型路由。没有情绪判读模型时，危机输入仍必须拿到安全提示。
          const utterance = envelope && envelope.input && typeof envelope.input.utterance === 'string'
            ? envelope.input.utterance
            : '';
          if (!crisisHit(utterance)) {
            if (dashboardHistory && typeof dashboardHistory.record === 'function') {
              try {
                await dashboardHistory.record(buildRoundObservation({
                  envelope,
                  rawResult: null,
                  result: null,
                  before: null,
                  after: null,
                  effects: null,
                  now: clock(),
                  attempts: 0,
                  status: 'failed',
                  errorCode: JUDGE_ERRORS.NO_ROUTE,
                }));
              } catch (error) {
                log(`[emotion] dashboard observation failed: ${(error && error.code) || (error && error.name) || 'Error'}`);
              }
            }
            return { ok: false, code: JUDGE_ERRORS.NO_ROUTE, phase: JUDGE_UNAVAILABLE_PHASE, attempts: 0 };
          }
        }
      }
      let judgedEnvelope = envelope;
      if (!isObject(envelope?.stateSnapshot) && typeof store.readLayer2 === 'function') {
        try {
          const layer2 = await store.readLayer2();
          const stateSnapshot = buildJudgeStateSnapshot(layer2, {
            now: clock(),
            scope: envelope?.relationshipRef || layer2?.scope,
          });
          if (stateSnapshot) {
            judgedEnvelope = { ...envelope, stateSnapshot };
          }
        } catch (error) {
          log(`[emotion] observer snapshot failed: ${(error && error.code) || (error && error.name) || 'Error'}`);
        }
      }
      const outcome = await judgeService.judge(judgedEnvelope, controller.signal);
      const llm = port.describe();
      return outcome && typeof outcome === 'object'
        ? { ...outcome, llm }
        : outcome;
    } catch (error) {
      // 最后一道兜底：判读链路任何位置抛异常，调用方拿到的也必须是一个稳定结果，
      // 不能让异常穿过 IPC/HTTP 边界（R2 派工单 P0-3「未捕获异常为零」）。
      log(`[emotion] judge threw: ${(error && error.name) || 'Error'}`);
      if (dashboardHistory && typeof dashboardHistory.record === 'function') {
        try {
          await dashboardHistory.record(buildRoundObservation({
            envelope,
            rawResult: null,
            result: null,
            before: null,
            after: null,
            effects: null,
            now: clock(),
            attempts: 0,
            status: 'failed',
            errorCode: JUDGE_ERRORS.FAILED,
          }));
        } catch {
          /* 看板观测失败不能覆盖稳定判读错误码 */
        }
      }
      return { ok: false, code: JUDGE_ERRORS.FAILED, attempts: 0 };
    } finally {
      inflight.delete(controller);
    }
  }

  /**
   * 脱敏状态：只给判读与存储的元信息，不含消息正文。
   *
   * @returns {Promise<object>} 状态摘要。
   */
  async function status() {
    let state = null;
    let layer2 = null;
    let usage = null;
    try {
      state = await store.readState();
      if (typeof store.readLayer2 === 'function') layer2 = await store.readLayer2();
      usage = await store.readUsage();
    } catch (error) {
      log(`[emotion] status read failed: ${error && error.name}`);
    }
    const budget = await judgeService.budgetStatus();
    return {
      closed,
      dataDirName: dataDir.split(/[\\/]/).pop(),
      schemaVersion: init && init.schemaVersion,
      readonly: store.getStatus() === 'readonly',
      files: (init && init.files) || [],
      llm: port.describe(),
      stats: { ...judgeService.stats },
      budget,
      state: state
        ? {
          emo: state.emo,
          feelings: state.feelings,
          axes: state.axes,
          updatedAt: state.updatedAt,
          hasLastEvent: Boolean(state.lastEventId),
        }
        : null,
      layer2: layer2 ? layer2View(layer2, clock()) : null,
      presence: presence?.status?.() || { available: false },
      usage: usage
        ? { judged: usage.judged, failed: usage.failed, degraded: usage.degraded }
        : null,
    };
  }

  /**
   * 完整只读看板快照。所有正文经 projection 重新组织，不直接返回 layer2。
   *
   * @returns {Promise<object>} 看板快照。
   */
  async function dashboard() {
    const now = clock();
    let state = null;
    let layer2 = null;
    let usage = null;
    let rounds = [];
    let points = [];
    let observedUsageSummary = null;
    let historyStatus = {
      available: false,
      records: 0,
      earliestAt: 0,
      latestAt: 0,
      retentionDays: 7,
      lastError: 'unavailable',
    };
    try {
      state = await store.readState();
      layer2 = typeof store.readLayer2 === 'function' ? await store.readLayer2() : null;
      usage = await store.readUsage();
    } catch (error) {
      log(`[emotion] dashboard state read failed: ${error && error.name}`);
    }
    if (dashboardHistory) {
      try {
        [rounds, points, observedUsageSummary] = await Promise.all([
          dashboardHistory.recent(60),
          dashboardHistory.points({ now, hours: 168, max: 240 }),
          typeof dashboardHistory.observedUsage === 'function'
            ? dashboardHistory.observedUsage({ now })
            : Promise.resolve(null),
        ]);
        historyStatus = dashboardHistory.status();
      } catch (error) {
        historyStatus = {
          ...historyStatus,
          available: false,
          lastError: (error && error.code) || (error && error.name) || 'read-failed',
        };
      }
    }
    const external = typeof getRuntime === 'function' ? getRuntime() : {};
    const budget = await judgeService.budgetStatus();
    return buildDashboardProjection({
      layer1: state,
      layer2,
      usage,
      runtime: {
        ready: !closed && Boolean(layer2),
        readonly: store.getStatus() === 'readonly',
        closed,
        schemaVersion: init?.schemaVersion,
        dataDirName: dataDir.split(/[\\/]/).pop(),
        llm: port.describe(),
        stats: { ...judgeService.stats },
        budget: isObject(budget) ? budget : null,
        background: isObject(external?.background) ? external.background : {},
      },
      rounds,
      points,
      observedUsageSummary,
      historyStatus,
      now,
      pluginVersion,
    });
  }

  /**
   * 给桥接层补写这一轮助手回复。未找到已记录轮次时稳定返回失败，不新建假轮。
   *
   * @param {{eventId?: string, reply?: string, at?: number, usage?: object, modelCosts?: object, source?: string}} input
   * @returns {Promise<object>}
   */
  async function observeReply(input = {}) {
    if (!dashboardHistory || typeof dashboardHistory.attachReply !== 'function') {
      return { ok: false, code: 'dashboard_history_unavailable' };
    }
    const reply = typeof input.reply === 'string'
      ? humanizeAssistantVoice(input.reply)
      : input.reply;
    return dashboardHistory.attachReply(input.eventId, reply, {
      at: input.at ?? clock(),
      usage: input.usage,
      modelCosts: input.modelCosts,
      source: input.source || 'integration',
    });
  }

  /**
   * 组织本轮模型可见的陪伴时钟信息。桥接层默认先预览，等上下文消息真正
   * 构造成功后调用 `acknowledgeCompanionContext()`，避免注入失败也丢提醒。
   *
   * @param {{sessionId?: string, eventId?: string, now?: number, markSeen?: boolean}} [input]
   * @returns {Promise<{text: string, snapshot?: object, ack?: object}>}
   */
  async function companionContext(input = {}) {
    if (!presence || typeof presence.formatContext !== 'function') {
      return { text: '' };
    }
    try {
      return await presence.formatContext({
        at: input.now ?? clock(),
        markSeen: input.markSeen === true,
      });
    } catch (error) {
      log(`[emotion] presence context failed: ${(error && error.code) || (error && error.name) || 'Error'}`);
      return { text: '' };
    }
  }

  /**
   * 确认陪伴时钟提醒已被注入模型上下文。
   *
   * @param {{returnAt?: number, idleSec?: number}} [input]
   * @returns {Promise<{ok: boolean, consumed: boolean}>}
   */
  async function acknowledgeCompanionContext(input = {}) {
    if (!presence || typeof presence.acknowledgeContext !== 'function') {
      return { ok: false, consumed: false };
    }
    try {
      return await presence.acknowledgeContext(input);
    } catch (error) {
      log(`[emotion] presence acknowledge failed: ${(error && error.code) || (error && error.name) || 'Error'}`);
      return { ok: false, consumed: false };
    }
  }

  /**
   * 给主动开口门控用的轻量时钟快照。不读 store，也不调用模型。
   *
   * @returns {object|null}
   */
  function presenceSnapshot() {
    try {
      return presence?.snapshot?.() || null;
    } catch (error) {
      log(`[emotion] presence snapshot failed: ${error?.code || error?.name || 'Error'}`);
      return null;
    }
  }

  /**
   * 只在门控已经允许开口后读取一次后台生活记录，供陪伴 Agent 自然接话。
   * 返回值不改变 seen_at；真正的开口由桥接层负责。
   *
   * @returns {Promise<object>}
   */
  async function proactiveContext() {
    const view = presenceSnapshot();
    if (!view) return { presence: null, background: {} };
    let background = {};
    try {
      const layer2 = await store.readLayer2();
      const value = isObject(layer2?.background) ? layer2.background : {};
      const localActivity = isObject(value.local_activity)
        && typeof value.local_activity.text === 'string'
        ? value.local_activity.text.trim().slice(0, 80)
        : '';
      background = {
        localActivity,
        line: backgroundLine(value),
        lastPassAt: Number(value.last_pass_at) || 0,
        watchedSince: Number(value.watched_since) || 0,
      };
    } catch (error) {
      log(`[emotion] proactive context read failed: ${error?.code || error?.name || 'Error'}`);
    }
    return { presence: view, background };
  }

  /**
   * 显式推进一次后台生活。默认只干跑；只有 `dryRun:false` 且明确允许模型时
   * 才可能产生内容。`passId` 是重启幂等键，同一个 id 不会二次占额度或写进度。
   *
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async function background(options = {}) {
    if (closed) return { ok: false, code: 'emotion_closed' };
    const checked = checkEventId(options.passId);
    if (!checked.ok) {
      return { ok: false, code: 'background_bad_pass_id', reason: checked.reason };
    }
    if (!store.readLayer2 || !store.commitLayer2) {
      return { ok: false, code: 'background_unavailable' };
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await store.readLayer2();
      if (current.background?.last_pass_id === checked.id) {
        return {
          ok: true,
          duplicate: true,
          passId: checked.id,
          record: { ok: true, duplicate: true, passId: checked.id, did: [] },
          view: layer2View(current, options.now ?? clock()),
        };
      }

      let call = typeof options.call === 'function' ? options.call : null;
      const controller = new AbortController();
      if (options.dryRun === false && !call && options.allowModel === true && typeof port.callText === 'function') {
        call = async (system, user) => {
          const got = await port.callText({
            system,
            user,
            signal: controller.signal,
            maxTokens: 512,
            temperature: 0.7,
          });
          if (!got.ok) throw Object.assign(new Error('background model failed'), { code: got.code });
          return got.text;
        };
      }

      inflight.add(controller);
      let outcome;
      try {
        outcome = await runLayer2Background(current, {
          passId: checked.id,
          now: options.now ?? clock(),
          dryRun: options.dryRun !== false,
          call,
          pickTask: options.pickTask,
          // 复用真实聊天状态里的最后消息时间。显式传入的 0 仍有意义，
          // 所以这里用 nullish 合并，而不是 `||`。
          lastUserAt: options.lastUserAt ?? current.mood?.last_user_msg_at,
          energy: options.energy,
          awakeGap: options.awakeGap,
        });
      } finally {
        inflight.delete(controller);
      }
      if (outcome.duplicate) {
        return {
          ok: true,
          duplicate: true,
          passId: checked.id,
          record: outcome.record,
          view: layer2View(outcome.state, options.now ?? clock()),
        };
      }
      if (!outcome.record?.ok) {
        return {
          ok: false,
          code: outcome.record?.error || 'background_model_failed',
          passId: checked.id,
          record: outcome.record,
        };
      }
      if (closed) return { ok: false, code: 'emotion_closed', passId: checked.id };

      const committed = await store.commitLayer2(outcome.state, {
        expectedUpdatedAt: current.updatedAt,
        expectedRevision: current.revision,
      });
      if (committed.ok) {
        return {
          ok: true,
          duplicate: false,
          passId: checked.id,
          record: outcome.record,
          view: layer2View(committed.state, options.now ?? clock()),
        };
      }
      if (committed.code !== 'layer2-conflict') {
        return { ok: false, code: committed.code || 'background_write_failed', passId: checked.id };
      }
    }
    return { ok: false, code: 'background_conflict', passId: checked.id };
  }

  /**
   * 只读迁移预览：不写旧目录、不写真实数据目录、不自动确认身份。
   *
   * @param {string} dir 旧数据目录。
   * @returns {Promise<object>} 预览报告（已脱敏）。
   */
  async function preview(dir) {
    return previewLegacy(dir);
  }

  /**
   * 显式确认迁移：第一次不带 digest 只返回预览；带正确 digest、review 确认和
   * 身份映射后才写目标目录。
   *
   * @param {object} options
   * @returns {Promise<object>}
   */
  async function migrate(options = {}) {
    if (closed) return { ok: false, code: 'emotion_closed' };
    const plan = await prepareLegacyMigration(options);
    if (!plan.ok) return plan;
    const artifacts = await writeMigrationArtifacts(dataDir, plan);
    if (!artifacts.ok) return artifacts;
    const committed = await store.commitMigration({
      migrationId: plan.migrationId,
      sourceDigest: plan.sourceDigest,
      state: plan.state,
      layer2State: plan.layer2State,
      at: options.now ?? clock(),
    });
    if (!committed.ok) {
      return {
        ok: false,
        code: committed.code || 'migration-commit-failed',
        migrationId: plan.migrationId,
      };
    }
    return {
      ok: true,
      duplicate: Boolean(committed.duplicate),
      migrationId: plan.migrationId,
      sourceDigest: plan.sourceDigest,
      summary: plan.summary,
    };
  }

  /**
   * 卸载：取消在途判读并关掉存储。
   *
   * @returns {Promise<void>}
   */
  async function close() {
    if (closed) return;
    closed = true;
    for (const controller of inflight) controller.abort();
    inflight.clear();
    try {
      await store.close();
    } catch (error) {
      log(`[emotion] store close failed: ${error && error.name}`);
    }
    try {
      await dashboardHistory?.close?.();
    } catch (error) {
      log(`[emotion] dashboard history close failed: ${error && error.name}`);
    }
  }

  return {
    judge,
    background,
    status,
    dashboard,
    companionContext,
    acknowledgeCompanionContext,
    presenceSnapshot,
    proactiveContext,
    observeReply,
    preview,
    migrate,
    close,
    /** 供启动摘要使用：一条不含正文的短句。 */
    summary() {
      const llm = port.describe();
      return [
        `dir=${dataDir.split(/[\\/]/).pop()}`,
        `schema=${(init && init.schemaVersion) || 0}`,
        `readonly=${store.getStatus() === 'readonly'}`,
        `llm=${llm.available ? `${llm.provider}/${llm.model}` : 'unavailable'}`,
        `route=${llm.source}`,
        `msg=${llm.messageFactory}`,
      ].join(' ');
    },
  };
}
