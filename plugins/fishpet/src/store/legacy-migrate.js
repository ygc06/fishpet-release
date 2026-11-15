/**
 * 旧 AstrBot 数据的显式确认迁移。
 *
 * 先复用脱敏预览取得源快照摘要；没有摘要、身份映射或敏感文件确认时零写入。
 * 确认后才按原始 JSON 转换，坏记录和数量不守恒一律停止。旧目录只读。
 *
 * @module dsh-fishpet-emotion/store/legacy-migrate
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { writeJsonAtomic, writeTextAtomic } from './atomic-json.js';
import { previewLegacy } from './migration-preview.js';
import { isMigrationId } from './migration-contract.js';
import { migrateEpisodeData } from '../memory/episodes.js';
import {
  createDefaultLayer2State,
  validateLayer2State,
} from './schema-v2.js';
import { createDefaultState, validateState } from './schema-v1.js';

const SOURCE_FILES = Object.freeze([
  'mood.json',
  'affinity.json',
  'episodes.json',
  'bg_state.json',
  'life.json',
  'inner.json',
  'promises.json',
  'skills.json',
  'core_memory.json',
  'conflict.json',
]);

const KNOWN_TOP_LEVEL = Object.freeze({
  'mood.json': new Set([
    'valence', 'energy', 'arousal', 'valence_base', 'cling_adj', 'updated_at',
    'last_user_msg_at', 'day', 'day_msgs', 'dialog', 'dominance', 'recent',
    'last_emo', 'ep_scope', 'clingy', 'trust', 'feelings_last', 'mood_line',
    'carry_last', 'pad', 'surge', 'extreme', 'last_impulse', 'regress',
    'neg_streak', 'reg_cool', 'trust_at',
  ]),
  'affinity.json': new Set(['users']),
  'episodes.json': new Set(['scopes', 'memory', 'items', 'last']),
  'bg_state.json': new Set([
    'ver', 'day', 'last_pass_id', 'passes_today', 'last_pass_at', 'backdrop',
    'ferment', 'queue', 'log_tail', 'last_beat',
  ]),
  'life.json': new Set([
    'version', 'energy', 'sleeping', 'sleep_at', 'sleep_until', 'turns',
    'last_turn_at', 'last_recover_at', 'wakes', 'epiphanies', 'closed_loops',
    'last_epiphany_at', 'epi_day', 'epi_day_count', 'hot_budget',
    'last_saved',
  ]),
  'inner.json': new Set([
    'version', 'next_id', 'gaps', 'dreams', 'scars', 'last_gap_inject',
    'last_msg_at', 'last_umo', 'last_share_at', 'last_dream_at',
  ]),
  'promises.json': new Set(['version', 'next_id', 'promises']),
  'skills.json': new Set(['version', 'next_id', 'rules']),
  'core_memory.json': new Set(['version', 'updated_at', 'entries', 'next_id']),
  'conflict.json': new Set(['version', 'stance', 'stance_at']),
});

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function within(root, target) {
  const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const base = normalize(root);
  const child = normalize(target);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  return child === base || child.startsWith(prefix);
}

function mergedObject(defaults, raw) {
  return isObject(raw) ? { ...clone(defaults), ...clone(raw) } : clone(defaults);
}

function scopeBucket(rawBucket) {
  if (!isObject(rawBucket)) return { items: [], last: {} };
  const lastValue = rawBucket.last;
  const last = isObject(lastValue)
    ? clone(lastValue)
    : Number.isFinite(Number(lastValue))
      ? { at: Number(lastValue) }
      : {};
  return {
    ...clone(rawBucket),
    items: Array.isArray(rawBucket.items) ? clone(rawBucket.items) : [],
    last,
  };
}

function canonicalDecision(identity, acceptReview) {
  return {
    schemaVersion: 1,
    legacyAffinityKey: identity.legacyAffinityKey,
    scope: identity.scope,
    actorName: identity.actorName,
    acceptReview: acceptReview === true,
  };
}

async function readSourceFiles(dir, rootReal) {
  const files = {};
  for (const name of SOURCE_FILES) {
    const file = path.join(dir, name);
    let info;
    try {
      info = await fs.lstat(file);
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw Object.assign(new Error('source-read-failed'), { code: 'source-read-failed' });
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw Object.assign(new Error('source-not-regular-file'), { code: 'source-not-regular-file' });
    }
    let real;
    try {
      real = await fs.realpath(file);
    } catch {
      throw Object.assign(new Error('source-read-failed'), { code: 'source-read-failed' });
    }
    if (!within(rootReal, real)) {
      throw Object.assign(new Error('source-escaped'), { code: 'source-escaped' });
    }
    let parsed;
    try {
      parsed = JSON.parse((await fs.readFile(real, 'utf8')).replace(/^\uFEFF/, ''));
    } catch {
      throw Object.assign(new Error('source-json-invalid'), {
        code: 'source-json-invalid',
        file: name,
      });
    }
    files[name] = parsed;
  }
  return files;
}

function layer1FromLegacy(mood, nowMs) {
  const next = createDefaultState(nowMs);
  if (!isObject(mood)) return next;
  next.updatedAt = Number.isFinite(Number(mood.updated_at))
    ? Number(mood.updated_at) * 1000
    : nowMs;
  next.axes = {
    valence: Number(mood.valence || 0),
    arousal: Number(mood.arousal || 0),
    clingy: Number(mood.clingy ?? mood.cling_adj ?? 0),
    dominance: Number(mood.dominance || 0),
  };
  next.feelings = Array.isArray(mood.feelings_last)
    ? mood.feelings_last.filter((item) => typeof item === 'string').slice(0, 3)
    : [];
  next.emo = String(mood.last_emo || '');
  next.mood = String(mood.mood_line || '');
  next.state = '';
  next.lastEventId = '';
  return next;
}

function publicPreview(preview) {
  return {
    digest: preview.digest,
    ok: preview.ok,
    files: clone(preview.files),
    json: clone(preview.json),
    counts: clone(preview.counts),
    schemas: clone(preview.schemas),
    identities: clone(preview.identities),
    manifest: clone(preview.manifest),
  };
}

/**
 * 生成迁移计划。该函数不向目标目录写任何文件。
 *
 * @param {object} options
 * @param {string} options.dir 旧数据目录。
 * @param {string} [options.confirmDigest] 预览返回的 digest。
 * @param {boolean} [options.acceptReview] 确认已人工看过 review 项。
 * @param {{legacyAffinityKey: string, scope: string, actorName?: string}} [options.identity]
 * @param {number} [options.now] Unix 毫秒，测试可注入。
 * @returns {Promise<object>}
 */
export async function prepareLegacyMigration(options = {}) {
  const dir = typeof options.dir === 'string' ? options.dir.trim() : '';
  const preview = await previewLegacy(dir, { includeSourceEntries: true });
  const visible = publicPreview(preview);
  if (!preview.ok) {
    return { ok: false, code: 'migration-source-not-clean', preview: visible };
  }
  if (typeof options.confirmDigest !== 'string' || !options.confirmDigest.trim()) {
    return { ok: false, code: 'confirmation-required', preview: visible };
  }
  if (options.confirmDigest.trim() !== preview.digest) {
    return { ok: false, code: 'preview-stale', preview: visible };
  }
  if (preview.counts.review > 0 && options.acceptReview !== true) {
    return { ok: false, code: 'review-confirmation-required', preview: visible };
  }

  const identity = isObject(options.identity) ? options.identity : {};
  const legacyAffinityKey = typeof identity.legacyAffinityKey === 'string'
    ? identity.legacyAffinityKey.trim()
    : '';
  const scope = typeof identity.scope === 'string' ? identity.scope.trim().slice(0, 240) : '';
  const actorName = typeof identity.actorName === 'string' ? identity.actorName.trim().slice(0, 60) : '';
  if (!legacyAffinityKey || !scope) {
    return { ok: false, code: 'identity-confirmation-required', preview: visible };
  }

  let rootReal;
  try {
    rootReal = await fs.realpath(dir);
  } catch {
    return { ok: false, code: 'migration-source-missing', preview: visible };
  }
  let source;
  try {
    source = await readSourceFiles(dir, rootReal);
  } catch (error) {
    return {
      ok: false,
      code: error?.code || 'source-read-failed',
      file: error?.file || '',
      preview: visible,
    };
  }
  for (const [name, raw] of Object.entries(source)) {
    if (!isObject(raw)) {
      return { ok: false, code: 'source-shape-invalid', file: name, preview: visible };
    }
  }

  const affinity = source['affinity.json'];
  const users = isObject(affinity) && isObject(affinity.users) ? affinity.users : {};
  if (!isObject(users[legacyAffinityKey])) {
    return { ok: false, code: 'identity-not-found', preview: visible };
  }

  const decision = canonicalDecision(
    { legacyAffinityKey, scope, actorName },
    options.acceptReview
  );
  const decisionDigest = sha256(Buffer.from(JSON.stringify(decision), 'utf8'));
  const migrationId = 'migration-' + sha256(
    Buffer.from(preview.digest + ':' + decisionDigest, 'utf8')
  ).slice(0, 40);

  const timestamps = [
    source['mood.json']?.updated_at,
    source['bg_state.json']?.last_pass_at,
    source['life.json']?.last_turn_at,
    source['inner.json']?.last_msg_at,
  ].map(Number).filter((value) => Number.isFinite(value) && value >= 0);
  const nowMs = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const nowSec = timestamps.length ? Math.max(...timestamps) : nowMs / 1000;
  const layer2 = createDefaultLayer2State(nowSec);

  const mood = source['mood.json'];
  if (isObject(mood)) {
    const moodKeys = [
      'valence', 'energy', 'arousal', 'valence_base', 'cling_adj', 'dominance',
      'trust', 'trust_at', 'updated_at', 'last_user_msg_at', 'last_emo',
      'last_impulse', 'regress', 'neg_streak', 'reg_cool', 'day', 'day_msgs',
      'surge',
    ];
    for (const key of moodKeys) {
      if (mood[key] !== undefined) layer2.mood[key] = clone(mood[key]);
    }
    if (isObject(mood.pad)) layer2.mood.pad = clone(mood.pad);
    if (isObject(mood.extreme)) layer2.mood.extreme = clone(mood.extreme);
    layer2.emotion.feelings = Array.isArray(mood.feelings_last)
      ? mood.feelings_last.filter((item) => typeof item === 'string').slice(0, 3)
      : [];
    layer2.emotion.emo = String(mood.last_emo || '');
    layer2.emotion.mood = String(mood.mood_line || '');
    layer2.emotion.carry = String(mood.carry_last || '');
    if (Array.isArray(mood.recent)) {
      layer2.context.recent = mood.recent
        .filter((item) => typeof item === 'string')
        .slice(-8)
        .map((text) => ({ t: String(text).slice(0, 120), at: nowSec, owner: true }));
    }
    if (Array.isArray(mood.dialog)) {
      layer2.context.dialog = mood.dialog
        .filter((item) => isObject(item))
        .slice(-80)
        .map((item) => ({
          role: String(item.r || item.role || '').slice(0, 8),
          t: String(item.t || item.text || '').slice(0, 160),
          at: Number(item.at || 0),
        }));
    }
  }

  const selectedAffinity = clone(users[legacyAffinityKey]);
  if (actorName) selectedAffinity.name = actorName;
  layer2.affinity.users[scope] = selectedAffinity;
  layer2.scope = scope;
  layer2.actorName = actorName || String(selectedAffinity.name || '');

  layer2.promises = mergedObject(layer2.promises, source['promises.json']);
  layer2.skills = mergedObject(layer2.skills, source['skills.json']);
  layer2.coreMemory = mergedObject(layer2.coreMemory, source['core_memory.json']);
  layer2.inner = mergedObject(layer2.inner, source['inner.json']);
  layer2.vitality = mergedObject(layer2.vitality, source['life.json']);
  layer2.background = mergedObject(layer2.background, source['bg_state.json']);
  layer2.conflict = mergedObject(layer2.conflict, source['conflict.json']);

  const quarantine = {
    schemaVersion: 1,
    reason: 'unconfirmed-identity-or-record',
    affinityUsers: [],
    episodes: [],
    memory: [],
  };
  for (const key of Object.keys(users).sort()) {
    if (key !== legacyAffinityKey) {
      quarantine.affinityUsers.push({ legacyKeyHash: sha256(Buffer.from(key, 'utf8')).slice(0, 16), record: clone(users[key]) });
    }
  }

  const rawEpisodes = source['episodes.json'];
  let importedEpisodeCount = 0;
  let importedMemoryCount = 0;
  let sourceEpisodeCount = 0;
  let sourceMemoryCount = 0;
  if (rawEpisodes !== undefined) {
    if (!isObject(rawEpisodes)) {
      return { ok: false, code: 'episodes-invalid', preview: visible };
    }
    if (
      (rawEpisodes.scopes !== undefined && !isObject(rawEpisodes.scopes))
      || (rawEpisodes.items !== undefined && !Array.isArray(rawEpisodes.items))
      || (rawEpisodes.memory !== undefined && !isObject(rawEpisodes.memory) && !Array.isArray(rawEpisodes.memory))
    ) {
      return { ok: false, code: 'episodes-invalid', preview: visible };
    }
    if (isObject(rawEpisodes.scopes)) {
      for (const bucket of Object.values(rawEpisodes.scopes)) {
        if (
          !isObject(bucket)
          || (bucket.items !== undefined && !Array.isArray(bucket.items))
        ) {
          return { ok: false, code: 'episodes-invalid', preview: visible };
        }
      }
    }
    if (isObject(rawEpisodes.memory)) sourceMemoryCount = Object.keys(rawEpisodes.memory).length;
    else if (Array.isArray(rawEpisodes.memory)) sourceMemoryCount = rawEpisodes.memory.length;
    if (isObject(rawEpisodes.scopes)) {
      for (const bucket of Object.values(rawEpisodes.scopes)) {
        if (isObject(bucket) && Array.isArray(bucket.items)) sourceEpisodeCount += bucket.items.length;
      }
    } else if (Array.isArray(rawEpisodes.items)) {
      sourceEpisodeCount = rawEpisodes.items.length;
    }

    let migrated;
    try {
      migrated = migrateEpisodeData(rawEpisodes);
    } catch (error) {
      return {
        ok: false,
        code: String(error?.message || '').includes('memory')
          ? 'memory-conservation'
          : 'episodes-conservation',
        preview: visible,
      };
    }
    const targetEpisodes = { scopes: {}, memory: [] };
    for (const [legacyScope, rawBucket] of Object.entries(migrated.scopes || {})) {
      const bucket = scopeBucket(rawBucket);
      if (legacyScope === legacyAffinityKey) {
        targetEpisodes.scopes[scope] = bucket;
        importedEpisodeCount += bucket.items.length;
      } else {
        quarantine.episodes.push({ legacyScopeHash: sha256(Buffer.from(legacyScope, 'utf8')).slice(0, 16), bucket });
      }
    }
    for (const item of migrated.memory || []) {
      if (String(item.scope || '') === legacyAffinityKey) {
        targetEpisodes.memory.push({ ...clone(item), scope });
        importedMemoryCount += 1;
      } else {
        quarantine.memory.push(item);
      }
    }
    if (
      importedEpisodeCount + quarantine.episodes.reduce((sum, item) => sum + item.bucket.items.length, 0)
      !== sourceEpisodeCount
      || importedMemoryCount + quarantine.memory.length !== sourceMemoryCount
    ) {
      return { ok: false, code: 'episodes-conservation', preview: visible };
    }
    layer2.episodes = targetEpisodes;
  }

  // 再核对一次源快照，防止预览与读取之间源文件发生变化却仍按旧摘要提交。
  let finalPreview;
  try {
    finalPreview = await previewLegacy(dir, { includeSourceEntries: true });
  } catch {
    return { ok: false, code: 'migration-source-missing', preview: visible };
  }
  if (finalPreview.digest !== preview.digest) {
    return { ok: false, code: 'preview-stale', preview: publicPreview(finalPreview) };
  }

  layer2.updatedAt = nowSec;
  if (!Number.isFinite(Number(layer2.mood.updated_at)) || Number(layer2.mood.updated_at) <= 0) {
    layer2.mood.updated_at = nowSec;
  }
  const layer2Check = validateLayer2State(layer2);
  if (!layer2Check.ok) {
    return {
      ok: false,
      code: 'migrated-state-invalid',
      reasons: layer2Check.reasons.slice(0, 30),
      preview: visible,
    };
  }
  const state = layer1FromLegacy(mood, nowMs);
  const stateCheck = validateState(state);
  if (!stateCheck.ok) {
    return {
      ok: false,
      code: 'migrated-state-invalid',
      reasons: stateCheck.reasons.slice(0, 30),
      preview: visible,
    };
  }

  const sourceManifest = {
    schemaVersion: 1,
    sourceDigest: finalPreview.digest,
    files: clone(finalPreview.files),
    entries: Array.isArray(finalPreview.sourceEntries) ? clone(finalPreview.sourceEntries) : [],
  };
  if (
    sourceManifest.entries.length !== sourceManifest.files.count
    || sourceManifest.entries.reduce((sum, entry) => sum + Number(entry.bytes || 0), 0)
      !== sourceManifest.files.totalBytes
  ) {
    return { ok: false, code: 'source-manifest-incomplete', preview: publicPreview(finalPreview) };
  }

  const unknownFields = {};
  for (const [name, raw] of Object.entries(source)) {
    if (!isObject(raw)) continue;
    const known = KNOWN_TOP_LEVEL[name] || new Set();
    const extra = Object.keys(raw).filter((key) => !known.has(key)).sort();
    if (extra.length) unknownFields[name] = extra;
  }

  return {
    ok: true,
    migrationId,
    sourceDigest: preview.digest,
    decisionDigest,
    decision,
    preview: visible,
    sourceManifest,
    state,
    layer2State: layer2,
    quarantine,
    summary: {
      filesRead: Object.keys(source).length,
      affinityMigrated: 1,
      affinityQuarantined: quarantine.affinityUsers.length,
      episodesMigrated: importedEpisodeCount,
      episodesQuarantined: quarantine.episodes.reduce((sum, item) => sum + item.bucket.items.length, 0),
      memoriesMigrated: importedMemoryCount,
      memoriesQuarantined: quarantine.memory.length,
      unknownFields,
    },
  };
}

/**
 * 把确认后的迁移产物写到目标私有目录。写产物不是业务提交；业务提交仍需
 * `store.commitMigration()`。
 *
 * @param {string} dataDir
 * @param {object} plan `prepareLegacyMigration()` 的成功结果。
 * @param {{fs?: object}} [options]
 * @returns {Promise<object>}
 */
export async function writeMigrationArtifacts(dataDir, plan, options = {}) {
  if (
    !plan
    || plan.ok !== true
    || !isMigrationId(plan.migrationId)
    || !isObject(plan.sourceManifest)
    || !Array.isArray(plan.sourceManifest.entries)
  ) {
    return { ok: false, code: 'invalid-migration-plan' };
  }
  const fsImpl = options.fs || fs;
  const root = path.join(dataDir, 'migrations', plan.migrationId);
  try {
    await fsImpl.mkdir(path.join(root, 'output'), { recursive: true });
    await fsImpl.mkdir(path.join(root, 'quarantine'), { recursive: true });
  } catch {
    return { ok: false, code: 'migration-artifact-failed' };
  }
  const writes = [
    ['source-manifest.json', plan.sourceManifest],
    ['preview.json', plan.preview],
    ['decisions.json', plan.decision],
    ['quarantine/records.json', plan.quarantine],
    ['output/state.json', plan.state],
    ['output/layer2-state.json', plan.layer2State],
  ];
  for (const [relative, value] of writes) {
    const written = await writeJsonAtomic(path.join(root, relative), value, { fs: fsImpl });
    if (!written.ok) return { ok: false, code: 'migration-artifact-failed' };
  }

  const checksumLines = [];
  for (const relative of writes.map(([name]) => name).sort()) {
    try {
      const content = await fsImpl.readFile(path.join(root, relative));
      checksumLines.push(`${sha256(content)}  ${relative.split(path.sep).join('/')}`);
    } catch {
      return { ok: false, code: 'migration-artifact-failed' };
    }
  }
  const checksums = await writeTextAtomic(
    path.join(root, 'checksums.sha256'),
    checksumLines.join('\n') + '\n',
    { fs: fsImpl }
  );
  if (!checksums.ok) return { ok: false, code: 'migration-artifact-failed' };
  return { ok: true, dirName: plan.migrationId };
}
