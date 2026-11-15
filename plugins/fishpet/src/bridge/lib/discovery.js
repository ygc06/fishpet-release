/**
 * 发现文件与 token（派工单 P0-3）。
 *
 *   $DSH_HOME/fishpet-bridge/bridge.json   —— 只放位置信息，不含 token
 *   $DSH_HOME/fishpet-bridge/token         —— 真正的 Bearer 明文，0600，每次启动轮换
 *
 * bridge.json 用「同目录 tmp + rename」原子替换；清理只在 pid 匹配自己时做。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SCHEMA = 1;
export const BINDING_SCHEMA = 2;

export function dshHome(env = process.env) {
  return env.DSH_HOME && String(env.DSH_HOME).trim() !== ''
    ? String(env.DSH_HOME)
    : join(homedir(), '.dsh');
}

export function bridgeDir(home = dshHome()) {
  return join(home, 'fishpet-bridge');
}

export function discoveryPath(home = dshHome()) {
  return join(bridgeDir(home), 'bridge.json');
}

export function tokenPath(home = dshHome()) {
  return join(bridgeDir(home), 'token');
}

export function bindingPath(home = dshHome()) {
  return join(bridgeDir(home), 'binding.json');
}

export function newToken() {
  return randomBytes(32).toString('base64url');
}

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** 原子替换写入一个 JSON 文件。 */
export function writeJsonAtomic(filePath, value) {
  ensureDir(join(filePath, '..'));
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, filePath);
}

/** 原子替换写入 token 文件（单独一行）。 */
export function writeToken(filePath, token) {
  ensureDir(join(filePath, '..'));
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  renameSync(tmp, filePath);
}

export function readToken(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8').trim();
    return raw.length >= 16 ? raw : null;
  } catch {
    return null;
  }
}

export function readDiscovery(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.schema !== SCHEMA) return null;
    if (typeof parsed.port !== 'number' || !Number.isFinite(parsed.port)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 只在发现文件属于自己这一个实例时才删。 */
export function removeDiscoveryIfOwned(filePath, pid) {
  const current = readDiscovery(filePath);
  if (current && current.pid !== pid) return false;
  try {
    rmSync(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** pid 是否还活着（用于桌宠侧判断发现文件是否陈旧）。 */
export function pidAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

/** 绑定状态持久化（桌宠重启后恢复）。 */
export function readBinding(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (parsed && parsed.schema === SCHEMA && typeof parsed.sessionId === 'string' && parsed.sessionId) {
      return parsed;
    }
  } catch {
    /* 首次运行或已损坏 */
  }
  return null;
}

export function writeBinding(filePath, sessionId) {
  writeJsonAtomic(filePath, { schema: SCHEMA, sessionId, lockedAt: Date.now() });
}

function normalizeBindingEntry(value) {
  if (!value || typeof value !== 'object') return null;
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : '';
  if (!sessionId) return null;
  const entry = {
    sessionId,
    lockedAt: Number(value.lockedAt) || Date.now(),
  };
  if (typeof value.agentPreset === 'string' && value.agentPreset.trim()) {
    entry.agentPreset = value.agentPreset.trim();
  }
  if (value.legacy === true) entry.legacy = true;
  return entry;
}

function normalizeRetiredChat(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean),
  )].slice(-1000);
}

/**
 * 读取显式 chat/work 绑定；旧 schema 1 的单会话文件按 work 迁移解释。
 *
 * @param {string} filePath binding.json 路径。
 * @returns {{schema:number, channels:{chat:object|null,work:object|null}}|null}
 */
export function readBindings(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.schema === BINDING_SCHEMA && parsed.channels && typeof parsed.channels === 'object') {
    return {
      schema: BINDING_SCHEMA,
      channels: {
        chat: normalizeBindingEntry(parsed.channels.chat),
        work: normalizeBindingEntry(parsed.channels.work),
      },
      retiredChat: normalizeRetiredChat(parsed.retiredChat),
    };
  }
  const legacyWork = normalizeBindingEntry(parsed);
  if (!legacyWork) return null;
  legacyWork.legacy = true;
  return {
    schema: SCHEMA,
    channels: { chat: null, work: legacyWork },
    retiredChat: [],
  };
}

/**
 * 原子写两种通道。空通道写 null，绝不删除另一条绑定。
 *
 * @param {string} filePath binding.json 路径。
 * @param {{chat?: object|null, work?: object|null}} channels 绑定。
 * @param {Iterable<string>} [retiredChat] 已明确退役的旧聊天会话。
 */
export function writeBindings(filePath, channels = {}, retiredChat = []) {
  const chat = normalizeBindingEntry(channels.chat);
  const work = normalizeBindingEntry(channels.work);
  const retired = normalizeRetiredChat(
    retiredChat == null
      ? []
      : Array.isArray(retiredChat)
        ? retiredChat
        : [...retiredChat],
  );
  if (!chat && !work && retired.length === 0) {
    clearBinding(filePath);
    return;
  }
  writeJsonAtomic(filePath, {
    schema: BINDING_SCHEMA,
    channels: {
      chat: chat ? { sessionId: chat.sessionId, lockedAt: chat.lockedAt, ...(chat.agentPreset ? { agentPreset: chat.agentPreset } : {}) } : null,
      work: work ? { sessionId: work.sessionId, lockedAt: work.lockedAt } : null,
    },
    retiredChat: retired,
    updatedAt: Date.now(),
  });
}

export function clearBinding(filePath) {
  try {
    rmSync(filePath, { force: true });
  } catch {
    /* ignore */
  }
}

/** 日志里永不出现 token 明文：最多给前 8 位 sha256。 */
export function tokenFingerprint(token) {
  try {
    // 延迟 import 会让本模块变成 async；直接用同步版本
    const { createHash } = process.getBuiltinModule
      ? process.getBuiltinModule('node:crypto')
      : { createHash: null };
    if (!createHash) return 'n/a';
    return createHash('sha256').update(String(token)).digest('hex').slice(0, 8);
  } catch {
    return 'n/a';
  }
}
