/**
 * FishPet 统一插件入口。
 *
 * 一个 DSH bundle 同时安装：
 * - 情绪判读、状态持久化和四页签看板；
 * - 供皮套连接的本机 HTTP + SSE 桥。
 *
 * 两部分仍在同一个 Cordis 上下文里独立启动。情绪服务先提供
 * `fishpetEmotion`，桥随后通过同一上下文读取它，不复制状态，也不另起进程。
 */

import {
  apply as applyEmotion,
  inject as emotionInject,
  name as emotionName,
  VERSION as EMOTION_VERSION,
} from './index.js';
import {
  apply as applyBridge,
  inject as bridgeInject,
} from './bridge/index.js';
import { dshHome } from './bridge/lib/discovery.js';
import {
  DEFAULT_COMPANION_PRESET,
  installCompanionToolPolicy,
} from './host/companion-tools.js';
import { createScreenState } from './host/screen-state.js';
import { join } from 'node:path';

export const name = emotionName;
export const VERSION = EMOTION_VERSION;

/** 单一 bundle 所需的全部 DSH 服务。 */
export const inject = [...new Set([...emotionInject, ...bridgeInject])];

/**
 * 同时启动情绪系统和皮套桥。
 *
 * `bridge` 配置单独分组；为兼容已有 profile，也接受顶层 `port` 与 `bindHost`。
 */
export function apply(ctx, rawConfig = {}) {
  const input = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const bridgeConfig = input.bridge && typeof input.bridge === 'object' ? input.bridge : {};
  const companion = input.companion && typeof input.companion === 'object'
    ? input.companion
    : {};
  const screen = input.screen && typeof input.screen === 'object'
    ? input.screen
    : {};
  const companionPreset = typeof companion.agentPreset === 'string'
    && companion.agentPreset.trim()
    ? companion.agentPreset.trim()
    : DEFAULT_COMPANION_PRESET;
  const screenState = createScreenState({
    file: join(dshHome(), 'fishpet-bridge', 'screen-state.json'),
    defaultEnabled: screen.enabledByDefault === true,
  });
  let bridge = null;
  const toolPolicy = installCompanionToolPolicy(ctx, {
    agentPreset: companionPreset,
    allowedTools: companion.allowedTools,
    screen: {
      state: screenState,
      enabled: () => screenState.enabled(),
      getActivity: () => bridge?.latestChatActivity() ?? null,
      claimOpportunity: () => bridge?.claimScreenOpportunity() === true,
      capture: typeof screen.capture === 'function'
        ? screen.capture
        : (options) => {
            if (!bridge || typeof bridge.requestScreenCapture !== 'function') {
              return Promise.reject(Object.assign(
                new Error('screen-pet-unavailable'),
                { code: 'screen-pet-unavailable' },
              ));
            }
            return bridge.requestScreenCapture(options);
          },
      clock: typeof screen.clock === 'function' ? screen.clock : undefined,
    },
  });
  const emotion = applyEmotion(ctx, input);
  bridge = applyBridge(ctx, {
    ...bridgeConfig,
    port: bridgeConfig.port ?? input.port,
    bindHost: bridgeConfig.bindHost ?? input.bindHost,
    companionCwd: bridgeConfig.companionCwd ?? companion.cwd,
    agentPreset: bridgeConfig.agentPreset ?? companionPreset,
    restrictCompanionAgent: toolPolicy.restrictSession,
    diagnoseCompanionAgent: toolPolicy.diagnoseSession,
    screenState,
    screenToolRegistered: toolPolicy.screenToolRegistered,
  });

  return {
    name,
    version: VERSION,
    emotion,
    bridge,
    toolPolicy,
    screenState,
    get ready() {
      return emotion.ready;
    },
    get error() {
      return emotion.error;
    },
    close: () => {
      toolPolicy.dispose();
      return emotion.close();
    },
  };
}
