/**
 * 存储层的公开入口：只导出 `createStore` 与 schema 常量/默认值，方便单测直接 require。
 *
 * @module dsh-fishpet-emotion/store/index
 */

export { createStore } from './store.js';
export {
  SCHEMA_VERSION,
  FILES,
  DATA_FILES,
  createDefaultMeta,
  createDefaultState,
  createDefaultUsage,
  validateState,
  validateUsage,
  validateMeta,
  validateLedgerRecord,
} from './schema-v1.js';
export {
  LAYER2_FILE,
  LAYER2_SCHEMA_VERSION,
  createDefaultLayer2State,
  validateLayer2State,
} from './schema-v2.js';
export { EVENTS_FILE, DEFAULT_MAX_BYTES, KEEP_ROTATED } from './event-log.js';
