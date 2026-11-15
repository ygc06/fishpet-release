#!/usr/bin/env node
/**
 * 迁移预览的 CLI 入口（`npm run preview`）。
 *
 * 为什么要有它：`previewLegacy()` 是个库函数，光有测试看不出「一条命令就能跑」。
 * 这里把它包成一个可执行入口：只读、脱敏、只打印统计，绝不打印正文。
 *
 * 用法：
 *   npm run preview                     # 预览仓库里的合成 fixture
 *   npm run preview -- <旧数据目录>      # 预览指定目录（只读）
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewLegacy } from '../src/store/migration-preview.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'test', 'fixtures', 'legacy-v1');
const requested = process.argv[2];
const target = requested ? path.resolve(requested) : fixture;

let preview;
try {
  preview = await previewLegacy(target);
} catch (error) {
  // 仓库内有合成样本；安装后的发布包不携带 test/。无参数运行时应给用法，
  // 不能把内部异常和绝对路径堆栈甩给用户。
  const code = error && error.message === 'legacy-missing' ? 'legacy-missing' : 'preview-failed';
  const usage = requested ? '' : '; pass a legacy data directory: npm run preview -- <dir>';
  console.error(`[preview] ${code}${usage}`);
  process.exit(2);
}
if (preview && preview.ok === undefined && preview.code) {
  // 只有「目录不存在 / 不是目录」这类硬错误才会没有 ok 字段
  console.error(`[preview] ${preview.code}`);
  process.exit(2);
}

// 只打统计与脱敏身份，不打正文：这是预览，不是导出。
const summary = {
  ok: preview.ok,
  dirLabel: preview.dirLabel,
  files: preview.files,
  json: preview.json,
  schemas: preview.schemas,
  counts: preview.counts,
  identities: preview.identities,
  manifest: preview.manifest,
  rejected: preview.rejected || [],
  unknownFieldCount: (preview.unknownFields || []).length,
  digest: preview.digest,
};

console.log(JSON.stringify(summary, null, 2));
process.exit(0);
