/**
 * 迁移 ID 的唯一格式合同。
 *
 * 迁移产物和完成标记都放在 `migrations/<migrationId>/` 下，因此不能复用
 * 较宽松的聊天 eventId 规则，否则调用方传入斜杠或 `..` 就可能把路径带出
 * 插件私有数据目录。
 */

export const MIGRATION_ID_RE = /^migration-[a-f0-9]{40}$/;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isMigrationId(value) {
  return typeof value === 'string' && MIGRATION_ID_RE.test(value);
}
