/**
 * 情绪系统的冻结枚举。
 *
 * 依据 `DSH-FishPet-情绪判读字段契约-v1-2026-11-12.md`：
 * - §5 数值增减上限
 * - §7 feelings
 * - §8 动作（四项，含旧系统被误删的「认一句」）
 * - §9 事件类型
 * - §10 surge / sting / mask / ep
 * - §11 文本长度
 * - §12 Live2D cue 白名单
 *
 * 本文件只放常量与冻结词表，不含逻辑；改词表等于改协议，必须同步契约文档。
 * `state.json` 的 schema v1 与 `layer2-state.json` 的 schema v2 共用这些判读字段。
 */

/** 单轮 delta 绝对值上限（契约 §5）。energy 不在其中：精力由程序按说话成本扣除。 */
export const DELTA_LIMITS = Object.freeze({
  valence: 35,
  arousal: 30,
  clingy: 25,
  dominance: 40,
});

/** delta 允许的键，顺序即展示顺序。 */
export const DELTA_KEYS = Object.freeze(['valence', 'arousal', 'clingy', 'dominance']);

/** burst 允许的键与幅度（契约 §5）。 */
export const BURST_LIMITS = Object.freeze({ min: 45, max: 85 });

/** bond 限幅（契约 §5）。 */
export const BOND_LIMITS = Object.freeze({ min: -2, max: 2 });

/** beats 规则（契约 §6）。 */
export const BEATS_LIMITS = Object.freeze({ maxItems: 4, maxQuoteChars: 20, minAbsValue: 1 });

/** feelings 规则（契约 §7）。 */
export const FEELINGS_LIMITS = Object.freeze({ maxItems: 3 });

/** 不作为显式感觉保留的词（契约 §7）。 */
export const FEELING_STOPWORDS = Object.freeze(['平静']);

/** 合法动作，四项同一常量（契约 §8）。 */
export const ACTIONS = Object.freeze(['靠近', '说难受', '划界退开', '认一句']);

/** 证据门槛达不到时退到的动作。 */
export const ACT_FALLBACK = '说难受';

/** 合法事件类型（契约 §9）。 */
export const EVENT_TYPES = Object.freeze(['亲近', '挑刺', '失约', '拒绝', '冷落', '修复', '普通']);

/** 未知事件类型退回的值。 */
export const EVENT_FALLBACK = '普通';

/** 事件字段长度上限（契约 §9）。 */
export const EVENT_LIMITS = Object.freeze({
  quoteChars: 40,
  whatChars: 60,
  labelChars: 12,
  weightMin: 0,
  weightMax: 10,
});

/** carry 枚举（契约 §11）。 */
export const CARRY_VALUES = Object.freeze(['沿用', '变了', '空']);

/** 文本字段长度上限，`[最小, 最大]`；单值为上限（契约 §11）。 */
export const TEXT_LIMITS = Object.freeze({
  state: Object.freeze([20, 1200]),
  mood: 60,
  let_go: 24,
  read: 80,
  monologue: 220,
  why: 60,
  judge: 40,
  body: 14,
});

/** state 里出现即清理的坏词（契约 §11）。 */
export const STATE_BAD_WORDS = Object.freeze(['系统', '模型', 'JSON', '参数', '数值']);

/** state 里出现即判为命令句式的词（契约 §11）。 */
export const STATE_COMMAND_WORDS = Object.freeze(['你别', '别问', '别哄', '别管', '我决定']);

/** surge 合法 kind 与 level 范围（契约 §10.1）。 */
export const SURGE_KINDS = Object.freeze(['被抱', '被亲', '靠近', '表白', '夸到点上']);

/** sting 合法 kind（契约 §10.2）。 */
export const STING_KINDS = Object.freeze(['贬低', '羞辱', '翻旧账', '威胁', '驱逐']);

/** mask 合法 kind 与 q 长度（契约 §10.3）。 */
export const MASK_KINDS = Object.freeze(['硬撑', '反话', '转移']);
export const MASK_QUOTE_CHARS = 12;

/** level 统一范围（契约 §10.1–10.3）。 */
export const LEVEL_LIMITS = Object.freeze({ min: 1, max: 3 });

/** ep 合法 state、索引范围、长度（契约 §10.4）。 */
export const EP_STATES = Object.freeze(['没问', '问了', '他答了', '了了', '删了']);
export const EP_FALLBACK = '没问';
export const EP_LIMITS = Object.freeze({ indexMin: 0, indexMax: 9, noteChars: 40, labelChars: 12 });

/** Live2D cue 白名单（契约 §12）。 */
export const LIVE2D_FACES = Object.freeze([
  '平静',
  '微笑',
  '开心',
  '生气',
  '哭',
  '难过',
  '发晕',
  '得意',
  '害羞',
  '紧张',
  '发愣',
]);

export const LIVE2D_DO = Object.freeze([
  '低头',
  '抬头',
  '点头',
  '摇头',
  '歪头左',
  '歪头右',
  '看左',
  '看右',
  '看屏幕',
  '看鼠标',
  '闭眼',
  '眨眼',
  '笑',
  '害羞',
  '惊讶',
  '放松',
  '凑近',
  '退开',
  '左重心',
  '右重心',
  '前倾',
  '后仰',
  '晃身',
  '裙摆',
]);

export const LIVE2D_SIZES = Object.freeze(['小', '中', '大']);
export const LIVE2D_PACES = Object.freeze(['慢', '自然', '快']);

/** Live2D cue 条数与 at 精度（契约 §12）。 */
export const LIVE2D_LIMITS = Object.freeze({ maxChecked: 8, maxKept: 4, atDecimals: 3 });

/** 判读通道（派工单 host 合同）。 */
export const CHANNELS = Object.freeze(['chat', 'work', 'desktop', 'game', 'scheduled']);

/** 稳定错误码：适配器与业务层共用，禁止临时改名字。 */
export const JUDGE_ERRORS = Object.freeze({
  NO_ROUTE: 'judge_unavailable',
  EMPTY: 'judge_empty',
  BAD_JSON: 'judge_bad_json',
  NOT_OBJECT: 'judge_not_object',
  ALL_FIELDS_BAD: 'judge_all_fields_bad',
  TIMEOUT: 'judge_timeout',
  ABORTED: 'judge_aborted',
  RATE_LIMIT: 'judge_rate_limited',
  AUTH: 'judge_auth',
  RETRY_EXHAUSTED: 'judge_retry_exhausted',
  DUPLICATE: 'judge_duplicate_event',
  FAILED: 'judge_failed',
});

/** 状态机里表示「没有可用路由」的相位（派工单：不更新情绪）。 */
export const JUDGE_UNAVAILABLE_PHASE = 'judge_unavailable';
