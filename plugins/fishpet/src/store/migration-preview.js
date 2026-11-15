/**
 * Read-only preview of legacy FishPet (AstrBot era) data.
 *
 * Contract: `previewLegacy(dir, options)` -> PreviewReport.
 *
 * Safety rules enforced here:
 * - Only `readdir`, `readFile` and `stat` are used. Nothing is written anywhere.
 * - No message body, quote, `what`/`text` value, or full identity key leaves this
 *   module: identities are masked with `id:` + sha256(key).slice(0, 8), field
 *   inventories keep names only, and `dirLabel` is a basename, never a path.
 * - The report is plain JSON data (no Buffer/Date/Map) and is byte-identical for
 *   the same input directory, including `digest`.
 *
 * Counting policy (documented so layer 2 can audit it):
 * - `counts.migrate` / `quarantine` / `exclude` / `review` count *records*.
 * - `episodes.json` scope items: empty scope name -> quarantine, otherwise migrate.
 * - `episodes.json` `memory` is an object table in legacy data. Its entries are
 *   counted as migrate records (one per key) and the shape is reported through
 *   the schema token `episodes.memory:object-table`; layer 2 must convert the
 *   table to an array with a stable key order and re-check the record count.
 * - `affinity.json` users are identity mappings: each one is a `review` record
 *   (needs human confirmation) and is also listed under `identities`.
 *   Nothing is merged and no owner is guessed.
 * - Unknown extra `.json` files count as one `review` record each.
 * - `README.md`, the manifest itself and any non-data file are only counted in
 *   `files`, never in `counts`.
 * - `MANIFEST.sha256` 里的文件名来自旧目录，属于不可信输入：只接受第一层的普通
 *   文件名，并在 realpath 之后再确认目标仍在旧目录内。违规条目不读取、不计数，
 *   只以清洗后的 basename 和稳定短码出现在 `rejected` 里（预览本身必须脱敏）。
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const REVIEW_FILES = [
  'mood.json',
  'inner.json',
  'life.json',
  'bg_state.json',
  'core_memory.json',
  'conflict.json',
  'promises.json',
  'skills.json',
];

const REVIEW_FILE_SET = new Set(REVIEW_FILES);
const JSONL_FILES = new Set(['inject_history.jsonl', 'bg_log.jsonl']);
const EXCLUDE_JSON = new Set(['pet_chat.json']);
const MANIFEST_NAME = 'MANIFEST.sha256';
const MIGRATION_SOURCE_FILES = new Set([
  'affinity.json',
  'episodes.json',
  ...REVIEW_FILES,
]);

const SCHEMA_BY_FILE = new Map([
  ['affinity.json', 'affinity.v0'],
  ['episodes.json', 'episodes.v0'],
  ['pet_chat.json', 'pet_chat.v0'],
  ...REVIEW_FILES.map((name) => [name, `${name.slice(0, -'.json'.length)}.v0`]),
]);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function maskIdentity(key) {
  return `id:${sha256(Buffer.from(String(key), 'utf8')).slice(0, 8)}`;
}

function parseJson(buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function countLines(buffer) {
  const text = buffer.toString('utf8');
  let lines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() !== '') lines += 1;
  }
  return lines;
}

function parseJsonl(buffer) {
  for (const line of buffer.toString('utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      JSON.parse(line);
    } catch {
      return false;
    }
  }
  return true;
}

function sensitivityForFile(name) {
  if (MIGRATION_SOURCE_FILES.has(name)) return 'sensitive-migration-source';
  if (JSONL_FILES.has(name) || EXCLUDE_JSON.has(name)) return 'sensitive-excluded';
  if (name === MANIFEST_NAME) return 'integrity-manifest';
  if (/\.bak(?:\.|$)/i.test(name) || name.includes('_archive')) return 'backup-excluded';
  if (/\.(?:md|txt)$/i.test(name)) return 'documentation';
  return 'not-migrated';
}

function emptyCounts() {
  return { migrate: 0, quarantine: 0, exclude: 0, review: 0 };
}

async function readManifest(buffer) {
  const entries = [];
  for (const rawLine of buffer.toString('utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (!match) continue;
    entries.push({ hash: match[1].toLowerCase(), name: match[2].trim() });
  }
  return entries;
}

const REJECT = {
  traversal: 'path-traversal',
  absolute: 'absolute',
  separator: 'separator',
  symlink: 'symlink-outside',
  notFile: 'not-a-file',
};

/**
 * 清单是纯文本输入，先做字符串分类，再决定是否拼路径。
 * 顺序即优先级：盘符/绝对路径 -> '..' 段 -> 分隔符 -> 合法单段名。
 * 先判穿越意图而不是先判分隔符，是因为 `sub/../../evil.txt` 的危险来自 `..`，
 * 审计时看到 path-traversal 比看到 separator 更能说明攻击面。
 */
function classifyManifestName(raw) {
  if (raw === '') return REJECT.notFile;
  if (/^[A-Za-z]:/.test(raw) || path.isAbsolute(raw) || /^[\\/]/.test(raw)) return REJECT.absolute;
  const segments = raw.split(/[\\/]+/);
  if (raw === '.' || raw === '..' || segments.includes('..')) return REJECT.traversal;
  if (segments.length > 1) return REJECT.separator;
  return null;
}

/**
 * 结果里只能出现单段 basename。旧清单可能写 `C:\x\y.txt` 或 `sub/../../evil.txt`，
 * 这些前缀一旦原样返回，就等于把旧机器的目录结构带进了预览报告。
 */
function manifestBasename(raw) {
  const parts = String(raw).split(/[\\/]+/).filter((part) => part !== '');
  let base = parts.length > 0 ? parts[parts.length - 1] : '';
  base = base.replace(/^[A-Za-z]:/, '');
  if (base === '' || base === '.' || base === '..') return 'unnamed';
  return base;
}

/** Windows 路径大小写不敏感，比较前统一小写，避免 `C:\Data` 与 `c:\data` 被当成两个根。 */
function insideRoot(rootReal, targetReal) {
  const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const root = normalize(rootReal);
  const target = normalize(targetReal);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target === root || target.startsWith(prefix);
}

/**
 * 真正判断一个名字能否读取。字符串校验之外还必须看 realpath：
 * 第一层的普通文件名也可能是符号链接，链接名本身不会暴露它指向旧目录之外。
 */
async function checkManifestTarget(rootReal, dir, name) {
  let targetReal;
  try {
    targetReal = await realpath(path.join(dir, name));
  } catch {
    return REJECT.notFile; // 不存在、断链或链接环：都不可读
  }
  if (!insideRoot(rootReal, targetReal)) return REJECT.symlink;
  let info;
  try {
    info = await stat(targetReal);
  } catch {
    return REJECT.notFile;
  }
  return info.isFile() ? null : REJECT.notFile;
}

/**
 * @param {string} dir legacy data directory (nothing outside it is read)
 * @param {{}} [options] reserved; currently unused
 * @returns {Promise<object>} PreviewReport
 */
export async function previewLegacy(dir, options = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new Error('legacy-missing');
  }

  let dirStat;
  try {
    dirStat = await stat(dir);
  } catch {
    throw new Error('legacy-missing');
  }
  if (!dirStat.isDirectory()) {
    throw new Error('legacy-missing');
  }

  // 后续所有清单校验都以 realpath 后的目录为根，符号链接目录也不会放宽边界。
  let rootReal;
  try {
    rootReal = await realpath(dir);
  } catch {
    throw new Error('legacy-missing');
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const counts = emptyCounts();
  const identities = [];
  const unknownFieldSet = new Set();
  const schemaSet = new Set();
  const parsed = new Map();
  const buffers = new Map();
  const sourceEntries = [];
  let totalBytes = 0;
  let jsonOk = 0;
  let jsonBad = 0;

  for (const name of files) {
    let buffer;
    try {
      buffer = await readFile(path.join(dir, name));
    } catch {
      continue; // vanished between readdir and read: keep the preview deterministic
    }
    buffers.set(name, buffer);
    totalBytes += buffer.length;
    const sourceEntry = {
      name,
      bytes: buffer.length,
      sha256: sha256(buffer),
      schema: 'binary-or-text',
      parseOk: null,
      sensitivity: sensitivityForFile(name),
    };
    sourceEntries.push(sourceEntry);

    if (name.endsWith('.json')) {
      let value;
      try {
        value = parseJson(buffer);
        sourceEntry.parseOk = true;
        jsonOk += 1;
        parsed.set(name, value);
      } catch {
        sourceEntry.parseOk = false;
        sourceEntry.schema = 'json:unparsable';
        jsonBad += 1;
        counts.review += 1; // a broken file needs a human decision, never a default
        schemaSet.add('json:unparsable');
        continue;
      }
      const schema = SCHEMA_BY_FILE.get(name);
      sourceEntry.schema = schema || 'json:unrecognized';
      if (schema) schemaSet.add(schema);
      else schemaSet.add('json:unrecognized');
    } else if (name.endsWith('.jsonl')) {
      sourceEntry.parseOk = parseJsonl(buffer);
      sourceEntry.schema = 'jsonl.v0';
      schemaSet.add('jsonl.v0');
      counts.exclude += countLines(buffer);
    } else if (name === MANIFEST_NAME) {
      sourceEntry.schema = 'manifest.sha256';
      schemaSet.add('manifest.sha256');
    }
  }

  // --- affinity: identities only, one review record each, never merged --------
  const affinity = parsed.get('affinity.json');
  if (isPlainObject(affinity) && isPlainObject(affinity.users)) {
    const keys = Object.keys(affinity.users).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const key of keys) {
      identities.push({ masked: maskIdentity(key), needsConfirm: true });
      counts.review += 1;
    }
  }
  identities.sort((a, b) => (a.masked < b.masked ? -1 : a.masked > b.masked ? 1 : 0));

  // --- episodes: scope items + legacy memory object table ---------------------
  const episodes = parsed.get('episodes.json');
  if (isPlainObject(episodes)) {
    if (isPlainObject(episodes.scopes)) {
      for (const scope of Object.keys(episodes.scopes)) {
        const book = episodes.scopes[scope];
        const items = isPlainObject(book) && Array.isArray(book.items) ? book.items.length : 0;
        if (scope === '') counts.quarantine += items;
        else counts.migrate += items;
      }
    }
    if (isPlainObject(episodes.memory)) {
      counts.migrate += Object.keys(episodes.memory).length;
      schemaSet.add('episodes.memory:object-table');
    } else if (Array.isArray(episodes.memory)) {
      counts.migrate += episodes.memory.length;
      schemaSet.add('episodes.memory:array');
    }
  }

  // --- pet_chat: excluded entirely -------------------------------------------
  const petChat = parsed.get('pet_chat.json');
  if (petChat !== undefined) {
    if (Array.isArray(petChat)) counts.exclude += petChat.length;
    else if (isPlainObject(petChat) && Array.isArray(petChat.items)) counts.exclude += petChat.items.length;
    else counts.exclude += 1;
  }

  // --- remaining JSON: 1 review record per file, field names only -------------
  for (const name of REVIEW_FILES) {
    const value = parsed.get(name);
    if (value === undefined) continue;
    counts.review += 1;
    if (isPlainObject(value)) {
      for (const key of Object.keys(value)) unknownFieldSet.add(key);
    }
  }

  // --- manifest verification -------------------------------------------------
  let manifest = { entries: 0, mismatch: 0 };
  const rejected = [];
  const manifestBuffer = buffers.get(MANIFEST_NAME);
  if (manifestBuffer) {
    const listed = await readManifest(manifestBuffer);
    manifest.entries = listed.length;
    for (const item of listed) {
      // 先做纯字符串分类，违规名字直接拒绝；只有通过的才允许拼路径和读文件。
      const reason = classifyManifestName(item.name) ?? (await checkManifestTarget(rootReal, dir, item.name));
      if (reason) {
        rejected.push({ name: manifestBasename(item.name), reason });
        manifest.mismatch += 1;
        continue; // 违规条目不读取：连 readFile 都不触发
      }
      let buffer = buffers.get(item.name);
      if (!buffer) {
        try {
          buffer = await readFile(path.join(dir, item.name));
        } catch {
          rejected.push({ name: manifestBasename(item.name), reason: REJECT.notFile });
          manifest.mismatch += 1;
          continue;
        }
      }
      if (sha256(buffer) !== item.hash) manifest.mismatch += 1;
    }
  }
  // 按名字/原因排序，保证同一份清单两次运行得到逐字节相同的报告。
  rejected.sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    if (a.reason === b.reason) return 0;
    return a.reason < b.reason ? -1 : 1;
  });

  const unknownFields = [...unknownFieldSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const schemas = [...schemaSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const body = {
    ok: jsonBad === 0 && manifest.mismatch === 0,
    dirLabel: path.basename(path.resolve(dir)),
    files: { count: files.length, totalBytes },
    json: { ok: jsonOk, bad: jsonBad },
    schemas,
    counts,
    unknownFields,
    identities,
    manifest,
    rejected,
  };

  // 文件名和正文不进入公开报告；它们只参与摘要。这样即使改了一个字段但
  // 文件大小、计数和字段名都不变，预览摘要仍会变化，不能把旧确认套到新数据上。
  const contentManifest = sourceEntries.map(({ name, bytes, sha256: hash }) => ({
    name,
    bytes,
    sha256: hash,
  }));
  const digest = sha256(Buffer.from(JSON.stringify({ body, files: contentManifest }), 'utf8'));
  const result = { ...body, digest };
  if (options && options.includeSourceEntries === true) {
    // 仅供迁移计划写本地产物；默认 preview() 不暴露文件名或逐文件哈希。
    result.sourceEntries = sourceEntries;
  }
  return result;
}
