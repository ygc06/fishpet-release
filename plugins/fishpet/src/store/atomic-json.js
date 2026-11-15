/**
 * 原子 JSON 读写工具（存储层专用）。
 *
 * 写入顺序固定为：同目录临时文件 → `FileHandle.sync()` → `rename()` 覆盖。
 * 绝不先删除旧文件；任何一步失败都删除临时文件，磁盘上始终保留上一份可用版本。
 * 返回结构化结果，且 `code` 只放 errno 名字（不把绝对路径或异常消息带出去）。
 *
 * @module dsh-fishpet-emotion/store/atomic-json
 */

import { promises as nodeFs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 临时文件前缀；同目录、以点开头，不会被当成业务文件。 */
export const TMP_PREFIX = '.tmp-';

/**
 * 把异常压成稳定 errno 名字；不回传 `error.message`（可能含绝对路径）。
 *
 * @param {unknown} error
 * @returns {string}
 */
export function errorCode(error) {
  if (error && typeof error === 'object') {
    const code = /** @type {{ code?: unknown }} */ (error).code;
    if (typeof code === 'string' && code) return code;
  }
  return 'io-error';
}

/**
 * @typedef {object} AtomicFs
 * @property {(file: string, options?: object) => Promise<import('node:fs/promises').FileHandle>} open
 * @property {(from: string, to: string) => Promise<void>} rename
 * @property {(file: string) => Promise<void>} unlink
 * @property {(file: string, options?: object) => Promise<string | Buffer>} readFile
 * @property {(file: string, options?: object) => Promise<unknown>} stat
 * @property {(dir: string, options?: object) => Promise<unknown>} mkdir
 * @property {(from: string, to: string) => Promise<void>} copyFile
 * @property {(dir: string, options?: object) => Promise<string[]>} readdir
 */

/** @returns {AtomicFs} */
function pickFs(options) {
  return (options && options.fs) || nodeFs;
}

/**
 * 判断路径是否存在（任意类型）。
 *
 * @param {string} target
 * @param {{fs?: AtomicFs}} [options]
 * @returns {Promise<boolean>}
 */
export async function pathExists(target, options = {}) {
  const fs = pickFs(options);
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读 JSON。ENOENT → `missing`；解析失败 → `corrupt`；两者都不抛错。
 *
 * @param {string} file
 * @param {{fs?: AtomicFs}} [options]
 * @returns {Promise<{ok: boolean, value?: unknown, missing?: boolean, corrupt?: boolean, code?: string}>}
 */
export async function readJson(file, options = {}) {
  const fs = pickFs(options);
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { ok: false, missing: true, code: 'missing' };
    return { ok: false, code: errorCode(error) };
  }
  try {
    return { ok: true, value: JSON.parse(String(text)) };
  } catch {
    return { ok: false, corrupt: true, code: 'bad-json' };
  }
}

/**
 * 在 `file` 所在目录写一个临时文件，fsync 后改名覆盖。
 *
 * @param {string} file 目标文件（绝对或相对）
 * @param {unknown} value 可 JSON 序列化的值
 * @param {{fs?: AtomicFs, tmpPrefix?: string}} [options]
 * @returns {Promise<{ok: true} | {ok: false, code: string}>}
 */
export async function writeJsonAtomic(file, value, options = {}) {
  const fs = pickFs(options);
  const prefix = (options && options.tmpPrefix) || TMP_PREFIX;
  const dir = path.dirname(file);

  let text;
  try {
    text = JSON.stringify(value, null, 2) + '\n';
  } catch {
    return { ok: false, code: 'bad-json-value' };
  }
  if (typeof text !== 'string') return { ok: false, code: 'bad-json-value' };

  const tmp = path.join(dir, prefix + process.pid + '-' + crypto.randomBytes(6).toString('hex'));
  /** @type {import('node:fs/promises').FileHandle | null} */
  let handle = null;
  try {
    handle = await fs.open(tmp, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmp, file);
    return { ok: true };
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* 关不上也要继续清理临时文件 */
      }
    }
    try {
      await fs.unlink(tmp);
    } catch {
      /* 临时文件可能根本没建起来 */
    }
    return { ok: false, code: errorCode(error) };
  }
}

/**
 * 原子写纯文本；迁移校验和使用这个入口，避免 `checksums.sha256` 出现半文件。
 *
 * @param {string} file
 * @param {string} text
 * @param {{fs?: AtomicFs, tmpPrefix?: string}} [options]
 * @returns {Promise<{ok: true} | {ok: false, code: string}>}
 */
export async function writeTextAtomic(file, text, options = {}) {
  const fs = pickFs(options);
  const prefix = (options && options.tmpPrefix) || TMP_PREFIX;
  const dir = path.dirname(file);
  const tmp = path.join(dir, prefix + process.pid + '-' + crypto.randomBytes(6).toString('hex'));
  /** @type {import('node:fs/promises').FileHandle | null} */
  let handle = null;
  try {
    handle = await fs.open(tmp, 'wx', 0o600);
    await handle.writeFile(String(text), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmp, file);
    return { ok: true };
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* 关不上也要继续清理临时文件 */
      }
    }
    try {
      await fs.unlink(tmp);
    } catch {
      /* 临时文件可能根本没建起来 */
    }
    return { ok: false, code: errorCode(error) };
  }
}

/**
 * 写一个空文件（用于首次创建 `events.jsonl`），同样是临时文件 + rename。
 *
 * @param {string} file
 * @param {{fs?: AtomicFs}} [options]
 * @returns {Promise<{ok: boolean, code?: string}>}
 */
export async function touchFileAtomic(file, options = {}) {
  const fs = pickFs(options);
  const tmp = path.join(
    path.dirname(file),
    TMP_PREFIX + process.pid + '-' + crypto.randomBytes(6).toString('hex')
  );
  let handle = null;
  try {
    handle = await fs.open(tmp, 'wx', 0o600);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmp, file);
    return { ok: true };
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
    }
    try {
      await fs.unlink(tmp);
    } catch {
      /* ignore */
    }
    return { ok: false, code: errorCode(error) };
  }
}

/**
 * 删除目录里遗留的临时文件（上一次进程被打断时留下）。
 *
 * 说明：本插件在一个 DSH 进程里只加载一次，写入由 store 的串行链排队，
 * 因此启动时不会与其他写者抢这些临时文件。
 *
 * @param {string} dir
 * @param {{fs?: AtomicFs}} [options]
 * @returns {Promise<number>} 删除成功的数量
 */
export async function cleanupTempFiles(dir, options = {}) {
  const fs = pickFs(options);
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    try {
      await fs.unlink(path.join(dir, name));
      removed += 1;
    } catch {
      /* 忽略单个遗留文件 */
    }
  }
  return removed;
}
