/**
 * 情绪系统的类型契约（JSDoc typedefs）。
 *
 * 只写实现依赖的契约，不写本机环境细节（开发机路径不进发布包）。
 * 运行环境没有 TypeScript 编译器、也不允许联网安装，因此实现是纯 ESM JavaScript；
 * `tsconfig.json` 只用于将来打开 `checkJs` 时复用这些注解，本轮没有跑过 `tsc`。
 *
 * @module dsh-fishpet-emotion/domain/types
 */

/**
 * 判读输入信封（派工单 Host 合同）。
 *
 * 由 Host 组装，不由 Client 自由拼接；第 1 层只强制 eventId 与基本形状。
 *
 * @typedef {object} JudgeEnvelopeV1
 * @property {string} eventId 稳定事件 id，用于一次性落账。
 * @property {'chat'|'work'|'desktop'|'game'|'scheduled'} channel 事件来源通道。
 * @property {number} at Unix 秒或毫秒时间戳（原样透传，不在此层换算）。
 * @property {string} source 事件来源标识（例如 channel + 会话短标识），不含正文。
 * @property {object} input 判读素材：`utterance`（当前原话）、`recent`（最近上下文数组）、`persona` 等。
 * @property {object} [stateSnapshot] 当前情绪状态的只读快照（自然语言化后的字段）。
 * @property {string} [relationshipRef] 关系引用（不含身份键）。
 * @property {string[]} [memoryRefs] 可引用的记忆条目 id 列表。
 */

/**
 * 情绪观察结果。
 *
 * 小模型只记录这一轮确实发生的结构化变化：轴增量、情绪词、动作、事件、
 * 外部撞入和 Live2D。程序负责计算状态，大模型负责理解原话和组织回答。
 * 至少需要一个小模型真实给出的可用观察字段；旧版预写散文不算观察。
 *
 * @typedef {object} JudgeResultV1
 * @property {Record<string, number>} delta 四轴增减，已限幅取整。
 * @property {string[]} feelings 最多三个不同情绪词（模型可给对象，归一化后为词）。
 * @property {string} emo 主情绪词。
 * @property {string} mood 历史兼容字段；新观察轮恒为空。
 * @property {string} state 历史兼容字段；新观察轮恒为空。
 * @property {string} act 四项动作之一。
 * @property {JudgeEvent} event 事件归一化结果。
 * @property {object[]} [beats] 拆分情绪节拍。
 * @property {object[]} [feelLinks] 情绪词与旧心绪词的对应关系。
 * @property {object[]} [live2d] Live2D cue（只作表现数据）。
 * @property {object} [surge] 突入信号。
 * @property {object} [sting] 刺痛信号。
 * @property {object} [mask] 嘴硬信号。
 * @property {object} [burst] 极端单轴变化。
 * @property {number} [bond] 本轮关系接近感 -2..+2。
 * @property {string} [carry] `沿用 / 变了 / 空`。
 * @property {string} [let_go] 确实放下的旧账短摘。
 * @property {object} [ep] 心绪清单条目的状态更新。
 * @property {string} [judge] 确实变化了的长期人物看法。
 * @property {string} [face] 整体表情。
 * @property {string} [read] 历史兼容字段；新观察轮恒为空。
 * @property {string} [body] 历史兼容字段；新观察轮恒为空。
 * @property {string} [why] 历史兼容字段；新观察轮恒为空。
 * @property {string[]} degraded 降级项：`字段.原因`，用于报告与测试断言。
 */

/**
 * @typedef {object} JudgeEvent
 * @property {string} type 七类之一。
 * @property {string} quote 原话证据，普通事件为空。
 * @property {string} what 事件描述，不含数字。
 * @property {string} label 短标签。
 * @property {string} who `他` 或 `我`。
 * @property {number} weight 0..10。
 * @property {boolean} unsolved 是否仍未解决。
 */

/**
 * 判读端口：Host 侧对业务暴露的唯一入口（派工单 `interface JudgePort`）。
 *
 * 职责边界（R1 派工单 P1-3 要求写清，两层名字都带 "port"，很容易混）：
 * - **JudgePort（这一层）**：业务语义。校验信封、查重、拼提示词、解析与归一化 JSON、
 *   限幅与降级、按证据门槛定动作、落账、投影状态、计数。它只记录「这一轮
 *   有哪些可验证的变化」，不替陪伴大模型写小作文或最终回答。
 * - **LLM port（`src/judge/dsh-llm-port.js`，内层）**：纯管道。选 provider/model、
 *   组织一次 stream、拼 `text-delta`、提取 JSON、超时与取消、把失败变稳定错误码。
 *   它**不认识** delta/feelings/act 这些字段，也不做任何业务校验或限幅。
 *
 * 换句话说：换掉 LLM port 只影响「怎么问观察模型」，不影响状态怎么算、怎么记。
 *
 * @typedef {object} JudgePort
 * @property {(envelope: JudgeEnvelopeV1, signal?: AbortSignal) => Promise<JudgeOutcome>} judge
 */

/**
 * 判读结果或稳定失败。
 *
 * @typedef {object} JudgeOutcome
 * @property {boolean} ok 成功为 true；失败时 `code` 必填且未落账。
 * @property {JudgeResultV1} [result] 成功时的归一化结果。
 * @property {string} [code] `JUDGE_ERRORS` 里的稳定错误码。
 * @property {number} [attempts] 实际调用模型的次数。
 * @property {boolean} [duplicate] 同一 eventId 已落账时为 true。
 */

/**
 * 已落账的事件记录（`events.jsonl` 每行一条）。
 *
 * @typedef {object} LedgerRecord
 * @property {number} schemaVersion 记录结构版本。
 * @property {string} eventId 事件 id。
 * @property {number} at 落账时间（毫秒）。
 * @property {string} channel 通道。
 * @property {string} act 动作。
 * @property {string} emo 主情绪。
 * @property {number[]} delta 四轴增量，顺序见 `DELTA_KEYS`。
 * @property {string} hash 结果内容哈希，用于幂等核对。
 */

/**
 * 插件私有存储的句柄（`src/store/store.js` 实现）。
 *
 * @typedef {object} EmotionStore
 * @property {() => Promise<StoreInitResult>} init 就绪：建目录、建 schema、探测损坏。
 * @property {() => Promise<StoredState>} readState 读取当前状态（损坏时为只读故障态）。
 * @property {(next: StoredState) => Promise<SaveResult>} saveState 校验后原子写入。
 * @property {(record: LedgerRecord) => Promise<AppendResult>} appendEvent 追加事件行。
 * @property {() => Promise<StoredUsage>} readUsage 读取用量计数。
 * @property {(patch: object) => Promise<StoredUsage>} bumpUsage 累加用量计数。
 * @property {(eventId: string) => Promise<boolean>} hasEventId 幂等检查。
 * @property {() => 'ready'|'readonly'} getStatus 当前可写性。
 * @property {() => Promise<void>} close 释放锁与句柄。
 */

/**
 * @typedef {object} StoreInitResult
 * @property {boolean} created 本次是否新建了目录或文件。
 * @property {number} schemaVersion 生效的 schema 版本。
 * @property {string[]} files 实际存在的文件名（不含绝对路径）。
 * @property {boolean} readonly 是否进入只读故障态。
 */

/**
 * @typedef {object} StoredState
 * @property {number} schemaVersion
 * @property {number} updatedAt
 * @property {object} axes 四轴当前值。
 * @property {string[]} feelings 心绪池。
 * @property {string} emo
 * @property {string} mood 旧版预写心情，仅保留兼容读取。
 * @property {string} state 旧版第一人称内心，仅保留兼容读取。
 * @property {string} lastEventId
 */

/**
 * @typedef {object} StoredUsage
 * @property {number} schemaVersion
 * @property {number} judged 判读次数。
 * @property {number} failed 失败次数。
 * @property {number} degraded 降级次数。
 * @property {number} lastJudgeAt
 */

/**
 * @typedef {object} SaveResult
 * @property {boolean} ok
 * @property {string} [code] 失败码（`schema-mismatch` / `readonly` / `invalid-state`）。
 */

/**
 * @typedef {object} AppendResult
 * @property {boolean} ok
 * @property {boolean} [duplicate] 同 eventId 已存在。
 * @property {string} [code]
 */

export {};
