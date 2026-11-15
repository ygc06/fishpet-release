/**
 * 情绪系统第 1 层的私有存储：`EmotionStore` 的正式实现。
 *
 * 目录结构（`<dir>` 由调用方用 DSH_HOME 推导，本模块不拼用户目录）：
 *   meta.json / state.json / usage.json / events.jsonl /
 *   event-ids.log（R2 只读） / event-ids.v2.log（新写入） / backups/
 *
 * 互斥与并发：本插件在一个 DSH 进程里只被加载一次，进程内没有第二个写者；
 * 所有写入（saveState / appendEvent / bumpUsage / init）都排在同一条 Promise 串行链上，
 * 因此不需要跨进程文件锁。跨进程读到的中间态由「临时文件 + rename」保证不会出现半份 JSON。
 *
 * 故障策略：读到的 JSON 坏了或 schemaVersion 不是 1 → 只读故障态；
 * 只做一次取证备份，不自动修复、不覆盖原文件。
 *
 * @module dsh-fishpet-emotion/store
 */

import { promises as nodeFs } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
  cleanupTempFiles,
  pathExists,
  readJson,
  touchFileAtomic,
  writeJsonAtomic,
} from './atomic-json.js';
import { createEventLog } from './event-log.js';
import {
  EVENT_INDEX_FILE,
  LEGACY_EVENT_INDEX_FILE,
  openEventIndex,
} from './event-index.js';
import {
  DATA_FILES,
  FILES,
  SCHEMA_VERSION,
  cloneJson,
  createDefaultMeta,
  createDefaultState,
  createDefaultUsage,
  isUnknownSchemaVersion,
  validateLedgerRecord,
  validateMeta,
  validateState,
  validateUsage,
} from './schema-v1.js';
import {
  LAYER2_SCHEMA_VERSION,
  createDefaultLayer2State,
  validateLayer2State,
} from './schema-v2.js';
import { isMigrationId } from './migration-contract.js';
import { checkEventId } from '../domain/event-id.js';

/**
 * @typedef {'ready' | 'readonly'} StoreStatus
 * @typedef {{ok: false, code: string}} StoreFailure
 */

/** 写前意图日志；提交成功后删除，崩溃时由 init 恢复。 */
const PENDING_FILE = 'pending-commit.json';
/** 迁移也使用写前意图，但它不是聊天事件，因此不追加账本或事件索引。 */
const PENDING_MIGRATION_FILE = 'pending-migration.json';
const MIGRATIONS_DIR = 'migrations';

/**
 * 创建存储句柄。构造不做任何 IO；`init()` 才落盘。
 *
 * @param {{dir: string, log?: (line: string) => void, fs?: object, maxEventBytes?: number}} options
 * @returns {import('../domain/types.js').EmotionStore & {init: () => Promise<import('../domain/types.js').StoreInitResult & {ok?: boolean, cause?: string}>}}
 */
export function createStore(options = {}) {
  const dir = typeof options.dir === 'string' ? options.dir.trim() : '';
  const fs = options.fs || nodeFs;
  const rawLog = typeof options.log === 'function' ? options.log : () => {};
  /** 日志器本身抛错不能影响存储操作。 */
  const log = (line) => {
    try {
      rawLog(line);
    } catch {
      /* ignore logger failure */
    }
  };

  /** @type {StoreStatus} */
  let status = 'readonly';
  /** @type {'' | 'invalid-dir' | 'corrupt' | 'schema-mismatch' | 'io-error'} */
  let cause = '';
  let closed = false;

  let cachedState = createDefaultState(0);
  let cachedLayer2 = createDefaultLayer2State(0);
  let cachedUsage = createDefaultUsage();

  /** @type {ReturnType<typeof createEventLog> | null} */
  const eventLog = dir
    ? createEventLog({ dir, fs, log, maxBytes: options.maxEventBytes })
    : null;

  /** 独立、永不轮转的 eventId 索引：长期去重的唯一依据。 */
  const eventIndex = dir
    ? openEventIndex({
        legacyFile: path.join(dir, LEGACY_EVENT_INDEX_FILE),
        file: path.join(dir, EVENT_INDEX_FILE),
        fs,
      })
    : null;

  const pendingFile = dir ? path.join(dir, PENDING_FILE) : '';
  const pendingMigrationFile = dir ? path.join(dir, PENDING_MIGRATION_FILE) : '';

  /** 写入串行链：任何写操作都挂在这条链上。 */
  let chain = Promise.resolve();

  /**
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function enqueue(task) {
    const run = chain
      .then(task, task)
      .catch(() => ({
        ok: false,
        code: 'internal-error',
        readonly: true,
        schemaVersion: SCHEMA_VERSION,
        files: [],
      }));
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * 只读故障时所有写操作的统一失败形状。
   *
   * @returns {StoreFailure | null}
   */
  function writeBlocked() {
    if (closed) return { ok: false, code: 'closed' };
    if (status === 'ready') return null;
    return { ok: false, code: cause === 'schema-mismatch' ? 'schema-mismatch' : 'readonly' };
  }

  async function ensureBackups() {
    const backups = path.join(dir, FILES.backups);
    if (await pathExists(backups, { fs })) return false;
    await fs.mkdir(backups, { recursive: true });
    return true;
  }

  /**
   * 计算文件 sha256（只用于取证去重，不进日志）。
   *
   * @param {string} file
   * @returns {Promise<string>} 失败时返回空串
   */
  async function hashFile(file) {
    try {
      const data = await fs.readFile(file);
      return createHash('sha256').update(data).digest('hex');
    } catch {
      return '';
    }
  }

  /**
   * 把损坏文件复制到 backups/。同一内容只留一份；同一文件后来坏成另一种样子仍会新建副本。
   *
   * @param {string} name
   * @returns {Promise<string | null>} 备份文件名（不含目录）
   */
  async function backupCorrupt(name) {
    const backups = path.join(dir, FILES.backups);
    let entries = [];
    try {
      entries = await fs.readdir(backups);
    } catch {
      entries = [];
    }
    const prefix = name + '.';
    const candidates = entries.filter(
      (entry) => entry.startsWith(prefix) && entry.endsWith('.corrupt')
    );
    const sourceHash = await hashFile(path.join(dir, name));
    if (sourceHash) {
      for (const candidate of candidates) {
        if ((await hashFile(path.join(backups, candidate))) === sourceHash) return null;
      }
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let target = name + '.' + stamp + '.corrupt';
    let suffix = 2;
    while (entries.includes(target)) {
      target = name + '.' + stamp + '-' + suffix + '.corrupt';
      suffix += 1;
      if (suffix > 50) {
        target = name + '.' + stamp + '-' + randomBytes(3).toString('hex') + '.corrupt';
        break;
      }
    }
    try {
      await fs.copyFile(path.join(dir, name), path.join(backups, target));
    } catch {
      return null;
    }
    log('emotion-store: backup file=' + name + ' as=' + target);
    return target;
  }

  async function listFiles() {
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      names = [];
    }
    return names
      .filter(
        (name) =>
          DATA_FILES.includes(name) ||
          name === LEGACY_EVENT_INDEX_FILE ||
          name === EVENT_INDEX_FILE
      )
      .sort();
  }

  /**
   * 把索引模块内部的绝对路径收窄成稳定文件名，避免 issues/API 暴露开发机路径。
   *
   * @param {string} target 当前问题文件。
   * @returns {string} `event-ids.log` 或 `event-ids.v2.log`。
   */
  function indexFileName(target) {
    if (eventIndex && target === eventIndex.legacyFile) return LEGACY_EVENT_INDEX_FILE;
    return EVENT_INDEX_FILE;
  }

  /**
   * 读一个 JSON 并归类：ok / missing / corrupt / mismatch。
   *
   * @param {string} name
   * @param {(value: unknown) => {ok: boolean}} validate
   * @returns {Promise<{kind: 'ok' | 'missing' | 'corrupt' | 'mismatch', value?: unknown}>}
   */
  async function classify(name, validate) {
    const read = await readJson(path.join(dir, name), { fs });
    if (read.ok) {
      if (isUnknownSchemaVersion(read.value)) return { kind: 'mismatch', value: read.value };
      if (!validate(read.value).ok) return { kind: 'corrupt' };
      return { kind: 'ok', value: read.value };
    }
    if (read.missing) return { kind: 'missing' };
    return { kind: 'corrupt' };
  }

  /**
   * layer2-state.json 有自己的 schema v2，不能套用 v1 的 `isUnknownSchemaVersion()`。
   *
   * @returns {Promise<{kind: 'ok' | 'missing' | 'corrupt' | 'mismatch', value?: unknown}>}
   */
  async function classifyLayer2() {
    const read = await readJson(path.join(dir, FILES.layer2), { fs });
    if (read.ok) {
      if (
        read.value
        && typeof read.value === 'object'
        && !Array.isArray(read.value)
        && 'schemaVersion' in read.value
        && read.value.schemaVersion !== LAYER2_SCHEMA_VERSION
      ) {
        return { kind: 'mismatch', value: read.value };
      }
      if (!validateLayer2State(read.value).ok) return { kind: 'corrupt' };
      return { kind: 'ok', value: read.value };
    }
    if (read.missing) return { kind: 'missing' };
    return { kind: 'corrupt' };
  }

  /**
   * 意图日志的结构校验：字段不全或记录/状态不合法都按 pending-corrupt 处理，绝不猜。
   *
   * @param {unknown} value
   * @returns {boolean}
   */
  function validatePendingIntent(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (value.schemaVersion !== SCHEMA_VERSION) return false;
    // 意图恢复会用这个 id 追加索引；不合合同的 id 必须当「坏的意图」处理，
    // 而不是重放后再栽在索引写入上（那会把 store 永久拖进 io-error）。
    const checkedId = checkEventId(value.eventId);
    if (!checkedId.ok || checkedId.id !== value.eventId) return false;
    if (!Number.isFinite(value.at)) return false;
    if (!value.record || typeof value.record !== 'object') return false;
    if (value.record.eventId !== value.eventId) return false;
    if (!validateLedgerRecord(value.record).ok) return false;
    if (!validateState(value.nextState).ok) return false;
    if (value.nextLayer2State !== undefined && value.nextLayer2State !== null) {
      if (!validateLayer2State(value.nextLayer2State).ok) return false;
    }
    return true;
  }

  /**
   * 迁移意图只替换两份状态，不携带聊天账本记录。
   *
   * @param {unknown} value
   * @returns {boolean}
   */
  function validatePendingMigration(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (value.schemaVersion !== SCHEMA_VERSION) return false;
    if (!isMigrationId(value.migrationId)) return false;
    if (typeof value.sourceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.sourceDigest)) {
      return false;
    }
    if (!Number.isFinite(value.at)) return false;
    if (!validateState(value.nextState).ok) return false;
    if (!validateLayer2State(value.nextLayer2State).ok) return false;
    return true;
  }

  /**
   * 迁移完成标记放在独立的 migrations/ 目录，不挤进两份业务状态。
   *
   * @param {string} migrationId
   * @returns {string}
   */
  function migrationMarkerFile(migrationId) {
    return path.join(dir, MIGRATIONS_DIR, migrationId, 'complete.json');
  }

  /**
   * @param {{migrationId: string, sourceDigest: string, nextState: object, nextLayer2State: object, at: number}} value
   * @returns {Promise<{ok: boolean, duplicate?: boolean, code?: string}>}
   */
  async function writeMigrationMarker(value) {
    const marker = migrationMarkerFile(value.migrationId);
    try {
      await fs.mkdir(path.dirname(marker), { recursive: true });
    } catch {
      return { ok: false, code: 'migration-marker-write-failed' };
    }
    const written = await writeJsonAtomic(marker, {
      schemaVersion: SCHEMA_VERSION,
      migrationId: value.migrationId,
      sourceDigest: value.sourceDigest,
      stateUpdatedAt: value.nextState.updatedAt,
      layer2UpdatedAt: value.nextLayer2State.updatedAt,
      at: value.at,
    }, { fs });
    return written.ok
      ? { ok: true }
      : { ok: false, code: 'migration-marker-write-failed' };
  }

  /**
   * 把仍然存在的账本 id 补进索引。
   *
   * 不只在索引文件不存在时执行：写账本成功、写索引失败后进程重启时，
   * 账本里的这条记录必须在进入 ready 前补回 v2 索引，否则会被当成未处理事件重放。
   * 旧索引里已存在、但账本已轮转掉的 id 不受影响。
   *
   * @returns {Promise<{ok: boolean, seeded?: number, code?: string}>}
   */
  async function reconcileIndex() {
    if (!eventIndex) return { ok: true, seeded: 0 };
    const ids = eventLog ? eventLog.ids() : [];
    let seeded = 0;
    for (const eventId of ids) {
      if (eventIndex.has(eventId)) continue;
      const result = await eventIndex.append(eventId);
      if (!result.ok && !result.duplicate) return { ok: false, code: 'index-write-failed' };
      if (result.ok) seeded += 1;
    }
    return { ok: true, seeded };
  }

  /**
   * 恢复写前意图：先补 state；索引里没有该 id 时再补日志与索引。
   * 索引已有 id 说明上次只差 state，绝不能重复追加账本。
   *
   * @returns {Promise<{ok: boolean, recovered?: boolean, corrupt?: boolean, code?: string}>}
   */
  async function recoverPending() {
    const read = await readJson(pendingFile, { fs });
    if (read.missing) return { ok: true, recovered: false };
    if (!read.ok || !validatePendingIntent(read.value)) return { ok: false, corrupt: true };
    const intent = read.value;
    const indexed = eventIndex.has(intent.eventId);

    if (intent.nextLayer2State) {
      const layer2Write = await writeJsonAtomic(path.join(dir, FILES.layer2), intent.nextLayer2State, { fs });
      if (!layer2Write.ok) return { ok: false, code: 'layer2-write-failed' };
      cachedLayer2 = cloneJson(intent.nextLayer2State);
    }
    const stateWrite = await writeJsonAtomic(path.join(dir, FILES.state), intent.nextState, { fs });
    if (!stateWrite.ok) return { ok: false, code: 'state-write-failed' };
    cachedState = cloneJson(intent.nextState);

    if (!indexed) {
      if (!eventLog.has(intent.eventId)) {
        const line = JSON.stringify(intent.record) + '\n';
        const ledgerWrite = await eventLog.append(intent.record, line);
        if (!ledgerWrite.ok) return { ok: false, code: 'ledger-write-failed' };
      }
      const indexWrite = await eventIndex.append(intent.eventId);
      if (!indexWrite.ok && !indexWrite.duplicate) return { ok: false, code: 'index-write-failed' };
    }

    try {
      await fs.unlink(pendingFile);
    } catch {
      /* 删除失败时下次 init 会幂等重放；数据已经一致 */
    }
    log('emotion-store: pending recovered mode=' + (indexed ? 'state-only' : 'full'));
    return { ok: true, recovered: true };
  }

  /**
   * 恢复一次未完成的迁移。两份状态按同一份意图重写，完成标记写成功后才删除意图。
   *
   * @returns {Promise<{ok: boolean, recovered?: boolean, corrupt?: boolean, code?: string}>}
   */
  async function recoverPendingMigration() {
    const read = await readJson(pendingMigrationFile, { fs });
    if (read.missing) return { ok: true, recovered: false };
    if (!read.ok || !validatePendingMigration(read.value)) {
      return { ok: false, corrupt: true };
    }
    const intent = read.value;
    const layer2Write = await writeJsonAtomic(
      path.join(dir, FILES.layer2),
      intent.nextLayer2State,
      { fs }
    );
    if (!layer2Write.ok) return { ok: false, code: 'layer2-write-failed' };
    cachedLayer2 = cloneJson(intent.nextLayer2State);

    const stateWrite = await writeJsonAtomic(path.join(dir, FILES.state), intent.nextState, { fs });
    if (!stateWrite.ok) return { ok: false, code: 'state-write-failed' };
    cachedState = cloneJson(intent.nextState);

    const marked = await writeMigrationMarker(intent);
    if (!marked.ok) return marked;
    try {
      await fs.unlink(pendingMigrationFile);
    } catch {
      /* 删除失败时下次 init 只会重写同一快照和完成标记 */
    }
    log('emotion-store: migration recovered id=' + intent.migrationId);
    return { ok: true, recovered: true };
  }

  async function doInit() {
    if (!dir) {
      status = 'readonly';
      cause = 'invalid-dir';
      return {
        ok: false,
        code: 'invalid-dir',
        created: false,
        schemaVersion: SCHEMA_VERSION,
        files: [],
        readonly: true,
      };
    }

    let created = false;
    try {
      if (!(await pathExists(dir, { fs }))) created = true;
      await fs.mkdir(dir, { recursive: true });
      if (await ensureBackups()) created = true;
    } catch (error) {
      status = 'readonly';
      cause = 'io-error';
      log('emotion-store: init failed dir=' + path.basename(dir));
      return {
        ok: false,
        code: 'io-error',
        created: false,
        schemaVersion: SCHEMA_VERSION,
        files: [],
        readonly: true,
      };
    }

    const meta = await classify(FILES.meta, validateMeta);
    const state = await classify(FILES.state, validateState);
    const layer2 = await classifyLayer2();
    const usage = await classify(FILES.usage, validateUsage);

    let events = { ok: true, missing: true };
    if (eventLog) events = await eventLog.init();

    let indexReady = true;
    let indexCorrupt = false;
    if (eventIndex) {
      try {
        await eventIndex.load();
        // 读不出 id 的索引行可能代表"已消费但读不回"的事件：不能当它不存在。
        indexCorrupt = eventIndex.corrupt;
      } catch {
        indexReady = false;
      }
    } else {
      indexReady = false;
    }

    const pendingRead = await readJson(pendingFile, { fs });
    const pendingInvalid =
      !pendingRead.ok && !pendingRead.missing
        ? true
        : pendingRead.ok
          ? !validatePendingIntent(pendingRead.value)
          : false;
    const pendingMigrationRead = await readJson(pendingMigrationFile, { fs });
    const pendingMigrationInvalid =
      !pendingMigrationRead.ok && !pendingMigrationRead.missing
        ? true
        : pendingMigrationRead.ok
          ? !validatePendingMigration(pendingMigrationRead.value)
          : false;
    const pendingBoth =
      pendingRead.ok
      && pendingMigrationRead.ok
      && !pendingInvalid
      && !pendingMigrationInvalid;

    const corruptFiles = [];
    /** @type {{file: string, reason: string}[]} */
    const issues = [];
    let mismatch = false;
    for (const [name, result] of [
      [FILES.meta, meta],
      [FILES.state, state],
      [FILES.layer2, layer2],
      [FILES.usage, usage],
    ]) {
      if (result.kind === 'corrupt') {
        corruptFiles.push(name);
        issues.push({ file: name, reason: 'bad-json' });
      }
      if (result.kind === 'mismatch') {
        mismatch = true;
        issues.push({ file: name, reason: 'schema-mismatch' });
      }
    }
    if (!events.ok) {
      if (events.schemaMismatch) {
        mismatch = true;
        issues.push({ file: events.file || FILES.events, reason: 'schema-mismatch' });
      } else {
        const file = events.file || FILES.events;
        corruptFiles.push(file);
        issues.push({
          file,
          reason: events.code === 'events.torn-tail' ? 'events.torn-tail' : 'events.bad-line',
        });
      }
    }

    if (!indexReady) {
      const unreadable = indexFileName((eventIndex && eventIndex.unreadableFile) || '');
      corruptFiles.push(unreadable);
      issues.push({ file: unreadable, reason: 'index-unreadable' });
    } else if (indexCorrupt) {
      // 索引里有一行无法确定它代表哪个 id → 按不可恢复处理，进只读。
      // 宁可拒绝服务，也不能让"已消费但读不出"的事件被重放。
      const corruptIndexFiles = new Set();
      if (eventIndex && eventIndex.issues.length) {
        for (const issue of eventIndex.issues) {
          const file = indexFileName(issue.file || '');
          corruptIndexFiles.add(file);
          issues.push({ ...issue, file });
        }
      } else {
        corruptIndexFiles.add(EVENT_INDEX_FILE);
        issues.push({ file: EVENT_INDEX_FILE, reason: 'index-corrupt' });
      }
      corruptFiles.push(...corruptIndexFiles);
    } else if (eventIndex && eventIndex.issues.length) {
      for (const issue of eventIndex.issues) {
        issues.push({ ...issue, file: indexFileName(issue.file || '') });
      }
    }
    if (pendingInvalid) {
      issues.push({ file: PENDING_FILE, reason: 'pending-corrupt' });
    }
    if (pendingMigrationInvalid) {
      issues.push({ file: PENDING_MIGRATION_FILE, reason: 'pending-corrupt' });
    }
    if (pendingBoth) {
      issues.push({ file: PENDING_MIGRATION_FILE, reason: 'pending-conflict' });
    }

    if (mismatch || corruptFiles.length || pendingInvalid || pendingMigrationInvalid || pendingBoth) {
      // 只读也要把能读的合法文件放进缓存，readState/readUsage 仍能返回最后一次可用值。
      if (state.kind === 'ok') cachedState = cloneJson(state.value);
      if (layer2.kind === 'ok') cachedLayer2 = cloneJson(layer2.value);
      if (usage.kind === 'ok') cachedUsage = cloneJson(usage.value);
      if (corruptFiles.length) {
        try {
          if (await ensureBackups()) created = true;
        } catch {
          /* 取证目录建不起来也不改变只读判定 */
        }
        for (const name of corruptFiles) await backupCorrupt(name);
      }
      status = 'readonly';
      if (mismatch) cause = 'schema-mismatch';
      else if (pendingInvalid || pendingMigrationInvalid || pendingBoth) cause = 'pending-corrupt';
      else if (indexCorrupt) cause = 'index-corrupt';
      else if (issues.some((issue) => issue.reason === 'events.torn-tail')) cause = 'events.torn-tail';
      else if (issues.some((issue) => issue.reason === 'events.bad-line')) cause = 'events.bad-line';
      else cause = 'corrupt';
      const files = await listFiles();
      log(
        'emotion-store: init dir=' + path.basename(dir) +
        ' readonly=true cause=' + cause +
        ' issues=' + issues.map((issue) => issue.reason).join(',') +
        ' files=' + files.length
      );
      return {
        ok: true,
        created,
        schemaVersion: SCHEMA_VERSION,
        files,
        readonly: true,
        cause,
        issues,
      };
    }

    try {
      const cleaned = await cleanupTempFiles(dir, { fs });
      if (cleaned) log('emotion-store: cleanup temp files=' + cleaned);

      if (meta.kind === 'missing') {
        await writeJsonAtomic(path.join(dir, FILES.meta), createDefaultMeta(), { fs });
        created = true;
      }
      if (state.kind === 'missing') {
        cachedState = createDefaultState();
        await writeJsonAtomic(path.join(dir, FILES.state), cachedState, { fs });
        created = true;
      } else {
        cachedState = cloneJson(state.value);
      }
      if (layer2.kind === 'missing') {
        cachedLayer2 = createDefaultLayer2State();
        await writeJsonAtomic(path.join(dir, FILES.layer2), cachedLayer2, { fs });
        created = true;
      } else {
        cachedLayer2 = cloneJson(layer2.value);
      }
      if (usage.kind === 'missing') {
        cachedUsage = createDefaultUsage();
        await writeJsonAtomic(path.join(dir, FILES.usage), cachedUsage, { fs });
        created = true;
      } else {
        cachedUsage = cloneJson(usage.value);
      }
      if (events.missing) {
        await touchFileAtomic(path.join(dir, FILES.events), { fs });
        created = true;
      }

      const boot = await reconcileIndex();
      if (!boot.ok) throw Object.assign(new Error('index reconcile failed'), { code: boot.code });
      if (boot.seeded) {
        created = true;
        log('emotion-store: index reconciled lines=' + boot.seeded);
      }

      const recovery = await recoverPending();
      if (!recovery.ok) {
        status = 'readonly';
        cause = recovery.corrupt ? 'pending-corrupt' : 'io-error';
        const files = await listFiles();
        log(
          'emotion-store: init dir=' + path.basename(dir) +
          ' readonly=true cause=' + cause +
          ' recovery=' + (recovery.code || 'pending-corrupt') +
          ' files=' + files.length
        );
        return {
          ok: false,
          code: recovery.code || 'pending-corrupt',
          created,
          schemaVersion: SCHEMA_VERSION,
          files,
          readonly: true,
          cause,
          issues,
        };
      }
      if (recovery.recovered) created = true;

      const migrationRecovery = await recoverPendingMigration();
      if (!migrationRecovery.ok) {
        status = 'readonly';
        cause = migrationRecovery.corrupt ? 'pending-corrupt' : 'io-error';
        const files = await listFiles();
        log(
          'emotion-store: init dir=' + path.basename(dir) +
          ' readonly=true cause=' + cause +
          ' recovery=' + (migrationRecovery.code || 'pending-corrupt') +
          ' files=' + files.length
        );
        return {
          ok: false,
          code: migrationRecovery.code || 'pending-corrupt',
          created,
          schemaVersion: SCHEMA_VERSION,
          files,
          readonly: true,
          cause,
          issues,
        };
      }
      if (migrationRecovery.recovered) created = true;
    } catch {
      status = 'readonly';
      cause = 'io-error';
      const files = await listFiles();
      log(
        'emotion-store: init dir=' + path.basename(dir) +
        ' readonly=true cause=io-error files=' + files.length
      );
      return {
        ok: false,
        code: 'io-error',
        created,
        schemaVersion: SCHEMA_VERSION,
        files,
        readonly: true,
      };
    }

    status = 'ready';
    cause = '';
    const files = await listFiles();
    log('emotion-store: init dir=' + path.basename(dir) + ' readonly=false files=' + files.length);
    return {
      ok: true,
      created,
      schemaVersion: SCHEMA_VERSION,
      files,
      readonly: false,
      issues,
    };
  }

  return {
    init() {
      return enqueue(doInit);
    },

    async readState() {
      return cloneJson(cachedState);
    },

    saveState(next) {
      return enqueue(async () => {
        const blocked = writeBlocked();
        if (blocked) return blocked;
        if (!validateState(next).ok) return { ok: false, code: 'invalid-state' };
        const result = await writeJsonAtomic(path.join(dir, FILES.state), next, { fs });
        if (!result.ok) return { ok: false, code: result.code };
        cachedState = cloneJson(next);
        log('emotion-store: save file=' + FILES.state);
        return { ok: true };
      });
    },

    appendEvent(record) {
      return enqueue(async () => {
        const blocked = writeBlocked();
        if (blocked) return blocked;
        if (!eventLog || !eventIndex) return { ok: false, code: 'readonly' };
        if (!validateLedgerRecord(record).ok) return { ok: false, code: 'invalid-event' };
        if (eventIndex.has(record.eventId)) return { ok: false, duplicate: true };
        if (eventLog.has(record.eventId)) {
          // 账本已经落盘、索引上次没补上：先补索引，再把这次调用当作重复。
          const repair = await eventIndex.append(record.eventId);
          if (!repair.ok && !repair.duplicate) {
            status = 'readonly';
            cause = 'io-error';
            return { ok: false, code: 'index-write-failed' };
          }
          return { ok: false, duplicate: true };
        }
        const line = JSON.stringify(record) + '\n';
        const result = await eventLog.append(record, line);
        if (!result.ok) return { ok: false, code: result.code || 'io-error' };
        const indexResult = await eventIndex.append(record.eventId);
        if (!indexResult.ok && !indexResult.duplicate) {
          status = 'readonly';
          cause = 'io-error';
          return { ok: false, code: 'index-write-failed' };
        }
        log('emotion-store: append file=' + FILES.events);
        return { ok: true };
      });
    },

    /**
     * 「读状态 → 投影 → 写状态 → 追加账本 → 追加索引」在同一临界区内完成。
     * 写 state 前先落 pending-commit.json；任何一步失败都保留意图，由下一次 init 幂等恢复。
     * 成功时返回 {ok:true, state}；已处理过返回 {ok:true, duplicate:true}。
     */
    commitJudge(input) {
      return enqueue(async () => {
        const blocked = writeBlocked();
        if (blocked) return blocked;
        if (!eventLog || !eventIndex) return { ok: false, code: 'readonly' };

        const eventId = input ? checkEventId(input.eventId) : { ok: false, reason: 'not-string' };
        const record = input ? input.record : null;
        const project = input ? input.project : null;
        const projectLayer2 = input ? input.projectLayer2 : null;
        // 第一道门：id 不合合同就什么都不写（不落意图、不碰 state/账本/索引）。
        if (!eventId.ok) {
          log('emotion-store: commit rejected id=' + eventId.reason);
          return { ok: false, code: 'invalid-commit', reason: 'eventId:' + eventId.reason };
        }
        const id = eventId.id;
        if (typeof project !== 'function') return { ok: false, code: 'invalid-commit' };
        if (projectLayer2 !== null && projectLayer2 !== undefined && typeof projectLayer2 !== 'function') {
          return { ok: false, code: 'invalid-commit' };
        }
        if (!record || typeof record !== 'object' || record.eventId !== id) {
          return { ok: false, code: 'invalid-commit' };
        }
        if (!validateLedgerRecord(record).ok) return { ok: false, code: 'invalid-commit' };
        if (eventIndex.has(id)) return { ok: true, duplicate: true };

        let next;
        try {
          next = project(cloneJson(cachedState));
        } catch {
          return { ok: false, code: 'project-failed' };
        }
        if (!validateState(next).ok) return { ok: false, code: 'invalid-commit' };

        let nextLayer2;
        if (typeof projectLayer2 === 'function') {
          try {
            nextLayer2 = projectLayer2(cloneJson(cachedLayer2));
          } catch {
            return { ok: false, code: 'layer2-project-failed' };
          }
          // `updatedAt` 是秒级业务时间，不能单独承担并发版本比较：同一秒内
          // 先后发生的聊天和后台生活可能拥有相同时间戳。每次第二层提交都推进
          // 单调 revision，旧的 v2 文件缺字段时从 0 开始兼容。
          nextLayer2.revision = Number(cachedLayer2.revision || 0) + 1;
          if (!validateLayer2State(nextLayer2).ok) {
            return { ok: false, code: 'invalid-layer2-commit' };
          }
        }

        const intent = {
          schemaVersion: SCHEMA_VERSION,
          eventId: id,
          record,
          nextState: next,
          ...(nextLayer2 ? { nextLayer2State: nextLayer2 } : {}),
          at: Date.now(),
        };
        const intentWrite = await writeJsonAtomic(pendingFile, intent, { fs });
        if (!intentWrite.ok) {
          status = 'readonly';
          cause = 'io-error';
          return { ok: false, code: 'state-write-failed' };
        }

        if (nextLayer2) {
          const layer2Write = await writeJsonAtomic(path.join(dir, FILES.layer2), nextLayer2, { fs });
          if (!layer2Write.ok) {
            status = 'readonly';
            cause = 'io-error';
            return { ok: false, code: 'layer2-write-failed' };
          }
          cachedLayer2 = cloneJson(nextLayer2);
        }

        const stateWrite = await writeJsonAtomic(path.join(dir, FILES.state), next, { fs });
        if (!stateWrite.ok) {
          status = 'readonly';
          cause = 'io-error';
          return { ok: false, code: 'state-write-failed' };
        }
        cachedState = cloneJson(next);

        const ledgerWrite = await eventLog.append(record, JSON.stringify(record) + '\n');
        if (!ledgerWrite.ok) {
          status = 'readonly';
          cause = 'io-error';
          return { ok: false, code: 'ledger-write-failed' };
        }

        const indexWrite = await eventIndex.append(id);
        if (!indexWrite.ok && !indexWrite.duplicate) {
          status = 'readonly';
          cause = 'io-error';
          return { ok: false, code: 'index-write-failed' };
        }

        try {
          await fs.unlink(pendingFile);
        } catch {
          /* 删除失败时下次 init 会按索引判断并只补 state；提交结果已经一致 */
        }
        log('emotion-store: commit ok');
        return {
          ok: true,
          state: cloneJson(next),
          ...(nextLayer2 ? { layer2State: cloneJson(nextLayer2) } : {}),
        };
      });
    },

    /**
     * 把一次已确认的旧数据迁移作为双状态快照提交。
     *
     * 迁移不是聊天事件，不追加 events.jsonl 或事件索引。两份状态先写备份，
     * 再落 pending-migration.json；崩溃恢复和人工重试都只会得到同一快照。
     *
     * @param {{migrationId: string, sourceDigest: string, state: object, layer2State: object, at?: number}} input
     * @returns {Promise<{ok: boolean, duplicate?: boolean, code?: string}>}
     */
    commitMigration(input) {
      return enqueue(async () => {
        const blocked = writeBlocked();
        if (blocked) return blocked;
        if (!isMigrationId(input?.migrationId)) {
          return { ok: false, code: 'invalid-migration-id' };
        }
        if (typeof input.sourceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(input.sourceDigest)) {
          return { ok: false, code: 'invalid-migration-digest' };
        }
        if (!validateState(input.state).ok || !validateLayer2State(input.layer2State).ok) {
          return { ok: false, code: 'invalid-migration-state' };
        }
        const at = Number.isFinite(Number(input.at)) ? Number(input.at) : Date.now();
        const migrationId = input.migrationId;
        const markerFile = migrationMarkerFile(migrationId);
        const markerRead = await readJson(markerFile, { fs });
        if (markerRead.ok) {
          const marker = markerRead.value;
          if (
            marker
            && typeof marker === 'object'
            && !Array.isArray(marker)
            && marker.schemaVersion === SCHEMA_VERSION
            && marker.migrationId === migrationId
          ) {
            if (marker.sourceDigest !== input.sourceDigest) {
              status = 'readonly';
              cause = 'corrupt';
              return { ok: false, code: 'migration-marker-conflict' };
            }
            if (
              Number(cachedState.updatedAt) === Number(input.state.updatedAt)
              && Number(cachedLayer2.updatedAt) === Number(input.layer2State.updatedAt)
            ) {
              return { ok: true, duplicate: true };
            }
            // 迁移本身已完成，但之后聊天又推进了状态。重试旧迁移不能把
            // 新状态倒回去，也不应把可正常聊天的 store 永久拖成只读。
            return { ok: false, code: 'migration_already_applied_or_state_changed' };
          }
          status = 'readonly';
          cause = 'corrupt';
          return { ok: false, code: 'migration-marker-corrupt' };
        }
        if (!markerRead.missing) {
          status = 'readonly';
          cause = 'corrupt';
          return { ok: false, code: 'migration-marker-corrupt' };
        }

        const backup = await writeJsonAtomic(
          path.join(dir, FILES.backups, migrationId + '.before.json'),
          {
            schemaVersion: SCHEMA_VERSION,
            migrationId,
            sourceDigest: input.sourceDigest,
            state: cachedState,
            layer2State: cachedLayer2,
            at,
          },
          { fs }
        );
        if (!backup.ok) return { ok: false, code: 'migration-backup-failed' };

        const intent = {
          schemaVersion: SCHEMA_VERSION,
          migrationId,
          sourceDigest: input.sourceDigest,
          nextState: input.state,
          nextLayer2State: input.layer2State,
          at,
        };
        const intentWrite = await writeJsonAtomic(pendingMigrationFile, intent, { fs });
        if (!intentWrite.ok) return { ok: false, code: 'migration-intent-write-failed' };

        const layer2Write = await writeJsonAtomic(
          path.join(dir, FILES.layer2),
          input.layer2State,
          { fs }
        );
        if (!layer2Write.ok) {
          status = 'readonly';
          cause = 'io-error';
          return { ok: false, code: 'layer2-write-failed' };
        }
        cachedLayer2 = cloneJson(input.layer2State);

        const stateWrite = await writeJsonAtomic(path.join(dir, FILES.state), input.state, { fs });
        if (!stateWrite.ok) {
          status = 'readonly';
          cause = 'io-error';
          return { ok: false, code: 'state-write-failed' };
        }
        cachedState = cloneJson(input.state);

        const marked = await writeMigrationMarker(intent);
        if (!marked.ok) {
          status = 'readonly';
          cause = 'io-error';
          return marked;
        }
        try {
          await fs.unlink(pendingMigrationFile);
        } catch {
          /* 删除失败时下次 init 会重写同一快照和完成标记 */
        }
        log('emotion-store: migration committed');
        return { ok: true, duplicate: false };
      });
    },

    async readLayer2() {
      return cloneJson(cachedLayer2);
    },

    saveLayer2(next) {
      return enqueue(async () => {
        const blocked = writeBlocked();
        if (blocked) return blocked;
        if (!validateLayer2State(next).ok) return { ok: false, code: 'invalid-layer2-state' };
        const result = await writeJsonAtomic(path.join(dir, FILES.layer2), next, { fs });
        if (!result.ok) return { ok: false, code: result.code };
        cachedLayer2 = cloneJson(next);
        log('emotion-store: save file=' + FILES.layer2);
        return { ok: true };
      });
    },

    /**
     * 原子替换第 2 层状态，可选 compare-and-swap。
     *
     * 后台生活不是判读账本事件，没有 events.jsonl 行；单文件原子写即可。
     * `expectedUpdatedAt` 与 `expectedRevision` 用来阻止基于旧快照的投影覆盖
     * 刚提交的聊天状态。秒级时间戳不够时，Host 应同时传 revision。
     */
    commitLayer2(next, options = {}) {
      return enqueue(async () => {
        const blocked = writeBlocked();
        if (blocked) return blocked;
        const nextState = cloneJson(next);
        nextState.revision = Number(cachedLayer2.revision || 0) + 1;
        if (!validateLayer2State(nextState).ok) return { ok: false, code: 'invalid-layer2-state' };
        const expected = options.expectedUpdatedAt;
        if (expected !== undefined && expected !== null) {
          if (!Number.isFinite(Number(expected))) return { ok: false, code: 'invalid-layer2-version' };
          if (Number(cachedLayer2.updatedAt) !== Number(expected)) {
            return { ok: false, code: 'layer2-conflict' };
          }
        }
        const expectedRevision = options.expectedRevision;
        if (expectedRevision !== undefined && expectedRevision !== null) {
          if (!Number.isInteger(Number(expectedRevision)) || Number(expectedRevision) < 0) {
            return { ok: false, code: 'invalid-layer2-version' };
          }
          if (Number(cachedLayer2.revision || 0) !== Number(expectedRevision)) {
            return { ok: false, code: 'layer2-conflict' };
          }
        }
        const result = await writeJsonAtomic(path.join(dir, FILES.layer2), nextState, { fs });
        if (!result.ok) return { ok: false, code: result.code };
        cachedLayer2 = cloneJson(nextState);
        log('emotion-store: commit file=' + FILES.layer2);
        return { ok: true, state: cloneJson(nextState) };
      });
    },

    async readUsage() {
      return cloneJson(cachedUsage);
    },

    bumpUsage(patch) {
      return enqueue(async () => {
        const blocked = writeBlocked();
        if (blocked) return blocked;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          return { ok: false, code: 'invalid-usage' };
        }
        const next = cloneJson(cachedUsage);
        for (const key of ['judged', 'failed', 'degraded']) {
          if (patch[key] === undefined) continue;
          const amount = Number(patch[key]);
          if (!Number.isInteger(amount) || amount < 0) return { ok: false, code: 'invalid-usage' };
          next[key] += amount;
        }
        if (patch.lastJudgeAt !== undefined) {
          const stamp = Number(patch.lastJudgeAt);
          if (!Number.isFinite(stamp) || stamp < 0) return { ok: false, code: 'invalid-usage' };
          next.lastJudgeAt = stamp;
        }
        next.schemaVersion = SCHEMA_VERSION;
        if (!validateUsage(next).ok) return { ok: false, code: 'invalid-usage' };
        const result = await writeJsonAtomic(path.join(dir, FILES.usage), next, { fs });
        if (!result.ok) return { ok: false, code: result.code };
        cachedUsage = next;
        log('emotion-store: usage file=' + FILES.usage);
        return { ...cloneJson(next), ok: true };
      });
    },

    async hasEventId(eventId) {
      if (!eventIndex) return false;
      return eventIndex.has(eventId);
    },

    getStatus() {
      return status;
    },

    async close() {
      closed = true;
      await chain.catch(() => undefined);
    },
  };
}
