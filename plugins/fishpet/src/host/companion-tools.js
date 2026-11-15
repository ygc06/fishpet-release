/**
 * Keep the companion preset a conversation, not a coding workbench.
 *
 * DSH inherits every globally registered tool into a new Agent. The companion
 * Agent therefore saw terminal, task-board, subagent, filesystem and image
 * tools even though its workspace is only a home for the character. Besides
 * wasting context, that made a greeting eligible for unrelated memory/tool
 * calls and split one reply across several assistant steps.
 *
 * This policy narrows only Agents running the companion preset. Work sessions
 * and every other preset keep their complete tool surface.
 */

import {
  buildScreenToolDefinition,
  SCREEN_TOOL_NAME,
} from './screen-tool.js';

export const DEFAULT_COMPANION_PRESET = 'fishpet-xiaoman-v6';

/**
 * Tools that may be useful while simply living and talking.
 *
 * The automatic memory context is supplied by Mnemon's prompt injection.
 * These explicit tools are only available when that plugin installed them;
 * otherwise the policy intersects the list with what this Host actually has.
 * In particular, `mnemon_runtime_memory` is intentionally absent: a casual
 * greeting must not turn into a memory lookup followed by a second reply.
 */
export const DEFAULT_COMPANION_TOOLS = Object.freeze([
  'mnemon_recall',
  'mnemon_remember',
  'mnemon_related',
]);

const TEAM_GUARD = Symbol.for('dsh-fishpet-emotion.team-membership-guard.v1');

function normalizeName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueNames(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const name = normalizeName(value);
    if (!name || seen.has(name) || name === 'run_code') continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

/**
 * Resolve the preset from every stable source DSH exposes during Agent setup.
 *
 * `composedPreset()` is the most direct answer, but its binding is not
 * guaranteed to exist yet when `agent/created` listeners run. The durable
 * session header and preset projection are independent fallbacks. Without
 * these fallbacks the companion silently kept every inherited workbench tool.
 */
function agentPresetOf(presets, agent) {
  const candidates = [];
  if (presets && typeof presets.composedPreset === 'function' && agent?.ctx) {
    try {
      candidates.push(presets.composedPreset(agent.ctx));
    } catch {
      // Continue with durable metadata below.
    }
  }
  if (presets && typeof presets.presetForSession === 'function' && agent?.session) {
    try {
      candidates.push(presets.presetForSession(agent.session));
    } catch {
      // A missing session projection is equivalent to an unknown preset.
    }
  }
  candidates.push(agent?.session?.header?.agentPreset);
  candidates.push(agent?.agentPreset);
  return candidates.find((value) => typeof value === 'string' && value.trim())?.trim() ?? '';
}

/**
 * Normalize the opt-in list without requiring DSH at import time.
 *
 * An explicit empty array means "hide all inherited global tools"; omitting
 * the field keeps the small default list.
 */
export function normalizeCompanionToolConfig(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    agentPreset: normalizeName(input.agentPreset) || DEFAULT_COMPANION_PRESET,
    allowedTools: Array.isArray(input.allowedTools)
      ? uniqueNames(input.allowedTools)
      : [...DEFAULT_COMPANION_TOOLS],
  };
}

/**
 * Intersect a configured allow-list with tools visible to one Agent.
 *
 * `hasTool` is injected so this remains a pure unit-testable decision. The
 * caller supplies DSH's own visible-tool lookup; names unavailable in another
 * installation are simply absent rather than making preset activation fail.
 */
export function selectCompanionTools(configured, hasTool) {
  const names = uniqueNames(configured);
  if (typeof hasTool !== 'function') return [];
  const selected = [];
  for (const name of names) {
    try {
      if (hasTool(name)) selected.push(name);
    } catch {
      // A disappearing tool registration is not a reason to break chat.
    }
  }
  return selected;
}

/**
 * Decide whether one tool call violates the companion allow-list.
 *
 * `run_code` is the PTC presentation transport, not an end capability. Keep
 * that transport transparent so an allowed nested tool is still reachable;
 * every nested dispatch is checked by its real tool name.
 */
function companionGuardReason(allowed, exec) {
  const name = normalizeName(exec?.name);
  if (name === 'run_code' || allowed.has(name)) return undefined;
  const label = name ? `tool "${name}"` : 'an unnamed tool';
  return `FishPet companion mode does not allow ${label}. Continue the reply without this tool.`;
}

/**
 * Keep a companion Agent out of the implicit Agent Team.
 *
 * DSH's Team roster intentionally treats every ordinary root Agent as a Team
 * Lead. The Team tool plugin then runs before this bundle and registers nine
 * tools directly in each Agent scope. `ctx.tools.restrict()` can hide inherited
 * global tools, but it cannot remove tools registered in the same scope.
 *
 * The narrow compatibility guard changes only the non-throwing membership
 * probe used by that plugin. Companion Agents report "not a member", so the
 * plugin never registers its scoped tools. Work Agents still call the original
 * implementation. The guard is reversible and leaves the Team service's
 * authoritative operations untouched.
 */
export function installCompanionTeamGuard(service, isCompanion) {
  if (
    !service
    || typeof service.tryMembership !== 'function'
    || typeof isCompanion !== 'function'
  ) {
    return { installed: false, dispose() {} };
  }
  if (service[TEAM_GUARD]) return service[TEAM_GUARD];

  const original = service.tryMembership;
  const guarded = function guardedTryMembership(agent) {
    let companion = false;
    try {
      companion = Boolean(isCompanion(agent));
    } catch {
      // A lifecycle lookup failure must not accidentally enroll the Agent in
      // a work team, but it also must not break the original Team service.
    }
    if (companion) return undefined;
    return original.call(this, agent);
  };
  const handle = {
    installed: true,
    dispose() {
      if (service.tryMembership === guarded) service.tryMembership = original;
      if (service[TEAM_GUARD] === handle) delete service[TEAM_GUARD];
    },
  };

  try {
    service.tryMembership = guarded;
    service[TEAM_GUARD] = handle;
  } catch {
    return { installed: false, dispose() {} };
  }
  return handle;
}

/**
 * Install an Agent-scoped allow mask for sessions using the companion preset.
 *
 * DSH applies `ctx.tools.restrict()` to inherited global tools. The preset
 * itself intentionally mounts no filesystem/search tool. A second execution
 * guard covers same-scope registrations that normal restrictions cannot mask,
 * including experimental Agent Teams tools on Host versions where the Team
 * membership compatibility hook is unavailable.
 */
export function installCompanionToolPolicy(ctx, rawConfig = {}) {
  const config = normalizeCompanionToolConfig(rawConfig);
  const screenConfig = rawConfig.screen && typeof rawConfig.screen === 'object'
    ? rawConfig.screen
    : null;
  const allowed = new Set([
    ...config.allowedTools,
    ...(screenConfig ? [SCREEN_TOOL_NAME] : []),
  ]);
  const pendingSessions = new Set();
  let screenToolRegistered = false;
  if (!ctx || typeof ctx.inject !== 'function') {
    return {
      dispose() {},
      config,
      restrictSession: () => false,
      screenToolRegistered: () => false,
    };
  }

  let disposed = false;
  let injected = null;
  let enforceSession = () => false;
  let diagnoseSession = () => null;
  let teamGuard = { installed: false, dispose() {} };
  let teamInjection = null;
  injected = ctx.inject(['agents', 'agentPresets', 'tools', 'attachments'], (scope) => {
    if (disposed) return () => {};
    const restrictions = new Map();
    const guards = new Map();

    const report = (message) => {
      try {
        console.log(`[emotion] companion tool policy: ${message}`);
      } catch {
        // Observability must not break the Agent lifecycle.
      }
    };

    const isCompanion = (agent) => {
      try {
        const presets = scope.get('agentPresets');
        return Boolean(agent?.ctx && agentPresetOf(presets, agent) === config.agentPreset);
      } catch {
        return false;
      }
    };

    let disposeScreenTool = null;
    const toolsService = scope.get('tools');
    const attachments = scope.get('attachments');
    if (
      screenConfig
      && toolsService
      && typeof toolsService.register === 'function'
      && attachments
      && typeof attachments.saveImage === 'function'
      && typeof screenConfig.enabled === 'function'
      && typeof screenConfig.getActivity === 'function'
    ) {
      try {
        const definition = buildScreenToolDefinition({
          screenState: screenConfig.state,
          getActivity: screenConfig.getActivity,
          claimOpportunity: screenConfig.claimOpportunity,
          saveImage: (image) => attachments.saveImage(image),
          capture: screenConfig.capture,
          clock: screenConfig.clock,
          log: screenConfig.log || report,
        });
        disposeScreenTool = toolsService.register(definition, {
          when: (activation) => Boolean(
            isCompanion(activation?.agent)
            && screenConfig.enabled() === true
          ),
        });
        screenToolRegistered = true;
      } catch (error) {
        report(`screen tool unavailable: ${(error && error.name) || 'Error'}`);
      }
    }

    const applyTo = (agent, force = false) => {
      if (!agent?.ctx) return false;
      const alreadyRestricted = restrictions.has(agent);
      const alreadyGuarded = guards.has(agent);
      if (alreadyRestricted && alreadyGuarded) {
        if (force) {
          report(`agent ${String(agent?.id || agent?.session?.id || '')} already restricted`);
        }
        return true;
      }
      if (!force && !isCompanion(agent)) return false;
      const tools = scope.get('tools');

      if (!alreadyRestricted) {
        try {
          if (!tools || typeof tools.get !== 'function') {
            if (force) report(`tool registry unavailable for agent ${String(agent?.id || agent?.session?.id || '')}`);
            throw new Error('tool registry unavailable');
          }
          const allow = selectCompanionTools(
            config.allowedTools,
            (name) => tools.get(name, agent) !== undefined,
          );
          if (
            screenToolRegistered
            && !allow.includes(SCREEN_TOOL_NAME)
          ) {
            // Screen permission may be toggled after this Agent already exists.
            // Keep the name in the restriction so activation can reveal it later.
            allow.push(SCREEN_TOOL_NAME);
          }
          if (force) {
            const view = typeof tools.view === 'function' ? tools.view(agent) : null;
            const restrictable = view ? [...(view.restrictableNames || [])].join(',') : 'unknown';
            report(`force ${String(agent?.id || agent?.session?.id || '')} restrictable=${restrictable}`);
          }
          const dispose = agent.ctx.tools.restrict({ allow });
          restrictions.set(agent, dispose);
          if (force) {
            report(`restricted agent ${String(agent?.id || agent?.session?.id || '')} allow=${allow.join(',')}`);
          }
        } catch (error) {
          report(`could not restrict session tools: ${(error && error.name) || 'Error'}: ${(error && error.message) || ''}`);
        }
      }

      if (!alreadyGuarded) {
        const agentTools = agent.ctx.tools;
        if (typeof agentTools?.guard === 'function') {
          try {
            const dispose = agentTools.guard((exec) => companionGuardReason(allowed, exec));
            if (typeof dispose !== 'function') {
              throw new TypeError('tools.guard() did not return a disposer');
            }
            guards.set(agent, dispose);
            if (force) {
              report(`guarded agent ${String(agent?.id || agent?.session?.id || '')} deny=non-allowlisted`);
            }
          } catch (error) {
            report(`could not guard session tools: ${(error && error.name) || 'Error'}: ${(error && error.message) || ''}`);
          }
        } else if (force) {
          report(`guard unavailable for agent ${String(agent?.id || agent?.session?.id || '')}`);
        }
      }

      return restrictions.has(agent) || guards.has(agent);
    };

    const agentForSession = (sessionId) => {
      const id = String(sessionId || '').trim();
      if (!id) return null;
      const agents = scope.get('agents');
      try {
        const direct = typeof agents?.get === 'function' ? agents.get(id) : null;
        if (direct) return direct;
      } catch {
        // Fall back to the live Agent registry below.
      }
      try {
        return (agents?.list?.() ?? []).find((agent) => String(
          agent?.id || agent?.session?.id || '',
        ) === id) ?? null;
      } catch {
        return null;
      }
    };

    // The bridge knows the companion session id before its first prompt even
    // when preset metadata is not bound yet. This explicit path is the final
    // authority and prevents cold/resumed sessions from inheriting work tools.
    enforceSession = (sessionId) => {
      const agent = agentForSession(sessionId);
      return agent ? applyTo(agent, true) : false;
    };

    diagnoseSession = (sessionId) => {
      const id = String(sessionId || '').trim();
      const agent = agentForSession(id);
      if (!agent) {
        return {
          live: false,
          pending: pendingSessions.has(id),
          restricted: false,
          guarded: false,
          visible: [],
          restrictable: [],
          scoped: [],
        };
      }
      try {
        const tools = scope.get('tools');
        const view = tools && typeof tools.view === 'function' ? tools.view(agent) : null;
        const visible = view ? [...view.visible.keys()] : [];
        const restrictable = view ? [...view.restrictableNames] : [];
        const restrictableSet = new Set(restrictable);
        return {
          live: true,
          pending: pendingSessions.has(id),
          restricted: restrictions.has(agent),
          guarded: guards.has(agent),
          visible,
          restrictable,
          scoped: visible.filter((name) => !restrictableSet.has(name)),
        };
      } catch (error) {
        return {
          live: true,
          pending: pendingSessions.has(id),
          restricted: restrictions.has(agent),
          guarded: guards.has(agent),
          error: (error && error.message) || 'diagnose-failed',
          visible: [],
          restrictable: [],
          scoped: [],
        };
      }
    };

    const lift = (agent) => {
      const disposeRestriction = restrictions.get(agent);
      const disposeGuard = guards.get(agent);
      restrictions.delete(agent);
      guards.delete(agent);
      for (const dispose of [disposeRestriction, disposeGuard]) {
        if (typeof dispose !== 'function') continue;
        try {
          dispose();
        } catch (error) {
          report(`could not lift session tools: ${(error && error.name) || 'Error'}`);
        }
      }
    };

    // Agent lifecycle events are dispatched through each Agent's own scope
    // carrier. A policy mounted at the Host root must opt into global delivery,
    // otherwise it never sees the Agent that is about to receive its first prompt.
    scope.on('agent/created', ({ agent }) => {
      const id = String(agent?.id || agent?.session?.id || '').trim();
      if (pendingSessions.has(id)) report(`created pending agent ${id}`);
      applyTo(agent, Boolean(id && pendingSessions.has(id)));
    }, { global: true });
    scope.on('agent/disposed', ({ agent }) => lift(agent), { global: true });
    for (const agent of scope.get('agents')?.list?.() ?? []) {
      const id = String(agent?.id || agent?.session?.id || '').trim();
      applyTo(agent, Boolean(id && pendingSessions.has(id)));
    }

    scope.effect(() => () => {
      for (const agent of [...restrictions.keys()]) lift(agent);
      if (typeof disposeScreenTool === 'function') {
        try {
          disposeScreenTool();
        } catch {
          // The owning Cordis scope also disposes registrations.
        }
      }
    }, 'fishpet: companion tool restriction');

    return () => {
      for (const agent of [...restrictions.keys()]) lift(agent);
      if (typeof disposeScreenTool === 'function') {
        try {
          disposeScreenTool();
        } catch {
          // The owning Cordis scope also disposes registrations.
        }
      }
    };
  });

  // Agent Team is optional. Keep its dependency in a separate fiber so a Host
  // without the Team bundle still activates the small tool allow-mask. When it
  // is present, this guard is installed before the first chat Agent reaches the
  // Team tool plugin, preventing both scoped tools and the Team policy prompt.
  try {
    teamInjection = ctx.inject(['agentTeams', 'agentPresets'], (teamScope) => {
      const teamService = teamScope.get('agentTeams');
      const presets = teamScope.get('agentPresets');
      const isCompanion = (agent) => {
        const id = String(agent?.id || agent?.session?.id || '').trim();
        if (id && pendingSessions.has(id)) return true;
        return agentPresetOf(presets, agent) === config.agentPreset;
      };
      teamGuard = installCompanionTeamGuard(teamService, isCompanion);
      if (teamGuard.installed) {
        console.log('[emotion] companion tool policy: isolated implicit Agent Team');
      }
      return () => teamGuard.dispose();
    });
  } catch {
    teamGuard = { installed: false, dispose() {} };
  }

  return {
    config,
    diagnoseSession(sessionId) {
      try {
        return diagnoseSession(sessionId);
      } catch {
        return null;
      }
    },
    restrictSession(sessionId) {
      const id = String(sessionId || '').trim();
      if (!id) return false;
      // First prompts create the live Agent after the bridge has only a durable
      // session id. Remember that id so `agent/created` can apply the mask even
      // when preset projection metadata is not bound yet.
      pendingSessions.add(id);
      try {
        return enforceSession(id) === true;
      } catch {
        return false;
      }
    },
    dispose() {
      disposed = true;
      try {
        teamGuard.dispose();
      } catch {
        // The Team service can disappear before this bundle during teardown.
      }
      try {
        if (teamInjection && typeof teamInjection.dispose === 'function') {
          teamInjection.dispose();
        }
      } catch {
        // The optional Team fiber may already have been disposed by its scope.
      }
      try {
        if (injected && typeof injected.dispose === 'function') injected.dispose();
      } catch {
        // The owning Cordis scope also disposes the injection.
      }
    },
    teamGuardInstalled() {
      return teamGuard.installed === true;
    },
    screenToolRegistered() {
      return screenToolRegistered === true;
    },
  };
}
