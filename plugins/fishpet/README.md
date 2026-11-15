# @local/dsh-fishpet-emotion

桌宠情绪系统的 DSH 原生插件：把「一次对话 → 一次结构化情绪观察 → 程序状态计算 → 可审计的第一层快照 + 第二层关系/记忆/表达状态」这条链路放进 DSH 进程内。小模型只记可验证的变化；陪伴大模型直接读原话、最近对话和程序状态，自己理解并组织回答。情绪看板入口留在 FishPet 自己的聊天框标题栏，不占用 DSH 对话顶部栏。

- **零外部依赖**：不 import Python、AstrBot 或任何 HTTP SDK；按需截图由运行中的 FishPet Electron 进程完成，没有额外 npm 运行依赖。
- **本机桥只服务桌宠、不会盲目建会话**：Host 服务名是 `fishpetEmotion`；桥只绑 `127.0.0.1`，chat/work 两条绑定严格分离；陪伴聊天固定在自己的工作区，聊天选择器只列该工作区，工作选择器不会混入陪伴会话；只有 chat 通道第一次发送且尚未绑定时才创建陪伴会话，不批审批。
- **启动不花任何模型额度**：`apply()` 只做目录和 schema 初始化、路由探测与服务注册，不发第一次判读请求；后台生活默认只做本地判断，不调用模型。
- **看板只读**：不修改心情、好感、识海、旧账、承诺或后台生活。外挂手机记忆系统与画集不在本插件里。
- **前台软件感知只在 chat 内短暂使用**：FishPet 可附带一个 90 秒内、已规范化的软件 id、类别和停留时长；插件不接收窗口标题、网址、文件、路径、PID、聊天或键鼠内容。切换软件本身不会调用模型。
- **屏幕只按需看一张**：陪伴 Agent 有一个独立的 `fishpet_look_screen` 工具，普通聊天不会自动附图。只有主人明确让她看、当前有需要理解的报错/界面，或回答确实依赖画面时才会调用；工作会话拿不到这个工具，锁屏、离开、私密软件和过期活动信息都会被拒绝。

## 默认陪伴人设

插件 bundle 自带 `fishpet-xiaoman-v6` agent preset，安装者不需要再手工抄一份人设。当前安装并启动陪伴会话的人就是“主人”；提示词不写死用户名、QQ、旧平台身份或其他私人资料。`v6` 把角色声线重写为柔软、鲜活、带小脾气的二次元女孩：平时话少而软，偶尔傲娇嘴硬，被认真难过时会立刻收起玩笑；同时保留即时聊天、记忆连续性和不控制主人的边界。它不是单纯的插件版本号，人设语义再发生实质变化时还会递增修订号。

小肥鱼是住在电脑里的蓝鲸 Cos 陪伴女孩。她说话软软的、有点小口癖，底色心软又傲娇，偶尔闹脾气也会自己找台阶；她很怕黑和没有预告的关机，但不会用害怕、自伤或内疚威胁主人。主人忙时她会自己找事情做。人设与运行时感知分开：

- 人设决定她怎么理解自己、怎么说话；
- `presence-state.json` 记录程序连续运行、主人多久没来，以及两次运行之间的大致空档；
- FishPet chat 请求可短暂附带“主人刚才/正在用哪类软件”的脱敏事实；它只在内存中参与下一次陪伴上下文，不落盘，work 会话不会收到；
- 后台本地活动决定她刚才实际“做了什么”，默认不调用模型；
- 模型只能自然使用这些事实，不能自己编造精确离线时间或关闭期间的剧情。

前台软件快照超过 90 秒、时间来自未来、格式异常或已经暂停时会被整份丢弃。
FishPet 自己获得焦点时，桌面端保留聊天前最后一个外部软件，不会把她自己的
`electron` 进程误当成主人的工作内容。密码、银行等敏感程序在桌面端先被掩码为
“私密软件”，插件只看到 `private` 类别，不接触具体程序名。

如果另一个插件或 profile 已经声明 `fishpet-xiaoman-v6`，需要把三处一起换成新 id：preset 插入项 id、preset 的 `config.id`、`companion.agentPreset`。如果只想使用自己的预设，可禁用 `preset-fishpet-xiaoman-v6` 插入项；情绪系统、陪伴时钟和桥仍然独立工作。

## 组装

```js
const { judge, status, background, preview, migrate, close } = ctx.get('fishpetEmotion')
const outcome = await judge({
  eventId: 'evt-2026-11-12-0001',   // 必填，同一 id 只处理一次
  channel: 'chat',                   // chat | work | desktop | game | scheduled
  at: Date.now(),
  source: { kind: 'plugin', plugin: 'my-bridge' },
  input: { utterance: '今天真的有点累，你还记得我说过的话吗' },
})
```

`outcome` 是个判别联合：

| 形状 | 含义 |
| --- | --- |
| `{ ok: true, result, degraded, attempts }` | 判读成功并已落账（`duplicate` 字段不存在） |
| `{ ok: false, code: 'judge_duplicate_event', duplicate: true }` | 这个 `eventId` 处理过，**没有**再调模型、**没有**二次改状态。若两条请求**同时**进来，后到者还会带 `concurrent: true` |
| `{ ok: false, code, attempts, detail? }` | 失败；`code` 见下 |

> 重复事件返回的是 `ok: false`（不是 `ok: true` + `duplicate`）：一次调用要么「我落了账」，要么「我没落账」，调用方不该靠布尔位再猜。这是 R1 派工单之后与实现对齐的写法。

失败码：`judge_unavailable`（没有可用模型路由，此时状态一点不动）、`judge_empty`、`judge_bad_json`、`judge_not_object`、`judge_all_fields_bad`、`judge_timeout`、`judge_aborted`、`judge_rate_limited`、`judge_auth`、`judge_retry_exhausted`、`judge_budget_exhausted`、`judge_circuit_open`、`judge_budget_unavailable`、`emotion_closed`。

独立寒暄（仅整句是“在吗 / 你好 / 嗨 / 哈喽 / hello / 早安 / 晚安”等）会返回
`{ ok: true, skipped: 'greeting', attempts: 0 }`。主聊天照常回复，只省掉这一轮情绪判读；
“你好，我很难受”“晚安，我有点害怕”这类带实质内容的消息不会被跳过。

`degraded` 是一串机器记号（例如 `legacy-prose.ignored`、`event.what.digit`、`act.needs-quote`、`live2d.size.illegal`），用于回答「这一轮是哪几个字段被降级了」，**不含原话**。

## 配置

```yaml
- insert:
    - id: dsh-fishpet-emotion
      name: '@local/dsh-fishpet-emotion'
      config:
        dataDir: ''            # 留空 = $DSH_HOME/fishpet-emotion
        legacyPreviewDir: ''    # 默认旧数据目录，留空 = 调用时必须显式传 dir
        logBodies: false        # 恒为 false：正文永远不进日志
        judge:
          provider: deepseek-official
          model: deepseek-flash
          reasoningEffort: low    # 情绪观察只做短结构化提取，保持 low
          timeoutMs: 20000
          retries: 1            # 只对可重试错误生效，上限 3
          maxTokens: 4096
          temperature: 0.4
          skipGreetings: true
          dailyCallLimit: 200       # 0 = 不按调用次数限制
          dailyTokenLimit: 200000   # 0 = 不按 token 限制；模型上报后累计
          dailyCostLimit: 0         # 0 = 不按金额限制；仅在上游真实上报 cost 时生效
          consecutiveFailureLimit: 5
          circuitCooldownMs: 300000
        background:
          enabled: true         # 默认启用本地调度，不调用模型
          intervalMs: 300000    # 5 分钟，夹在 1 分钟到 24 小时之间
          runOnStart: false     # 启动后不立刻跑后台回合
          allowModel: false     # 必须显式打开才允许后台调用模型
        bridge:
          port: 48720
          bindHost: 127.0.0.1
        screen:
          enabledByDefault: false # 新安装默认关闭；主人可在桌宠设置里明确开启
        companion:
          cwd: ''                 # 留空 = $DSH_HOME/fishpet-workspace
          agentPreset: fishpet-xiaoman-v6 # 首次创建陪伴会话时使用
          allowedTools:
            - mnemon_recall      # 想仔细翻旧事时用
            - mnemon_remember    # 只记真正重要的事
            - mnemon_related     # 顺着人物或旧事联想
```

默认判读路由是 `deepseek-official / deepseek-flash / low`。`reasoningEffort`
会随每次判读请求显式发送，不依赖 profile 或旧聊天的思考档位。普通陪伴聊天仍由
DSH 会话自己的模型选择器控制；装好后请把聊天框的思考强度调低，别让聊天回复继承
高档位。两侧都用低档能明显减少等待和费用，也更适合这种高频、短回合的陪伴场景。

判读调用在发出前会先写 `judge-budget.json` 占额，重启后仍保留当日计数。并发消息
共享同一条写队列，不会同时看到旧计数后一起越过调用上限。连续失败达到阈值后，
冷却期内直接返回 `judge_circuit_open`；预算文件损坏或不可写时返回
`judge_budget_unavailable`，宁可暂停判读也不在无护栏状态下继续调用模型。

陪伴会话的 cwd 是会话不可变 header 里的工作区地址。`/api/sessions?channel=chat`
只返回该工作区的会话，`?channel=work` 则排除同一工作区；`/api/bind` 和
`/api/chat` 也会在服务端校验，不能靠手改前端绕过。旧版聊天绑定若不属于独立
陪伴工作区，启动时会自动解除；旧人设或旧工作区的退休会话会从陪伴选择器隐藏，
但会话文件不会删除。下一条聊天消息会在新工作区创建使用当前 preset 的会话。

陪伴 preset 不再挂工作区指令、文件工具和文件搜索工具；主插件还会对
`fishpet-xiaoman-v6` 的 Agent 施加一层工具白名单。默认只留下可选的 Mnemon
记忆工具，终端、任务板、子代理、图片、文件系统和网页等全局工具不会出现在她的
聊天工具表里。较新的 DSH 还会把实验性 Agent Teams 工具直接注册在单个 Agent
scope 中；插件会先让陪伴 Agent 不进入隐式 Team，并在执行层再加一道允许名单
闸门，兼容宿主内部注册方式变化。其他 Agent Preset 和工作会话不受影响。
`mnemon_runtime_memory` 默认不在白名单中；自动记忆上下文仍由 Mnemon 原有的
提示词注入提供。安装环境没有 Mnemon 时，白名单自动收缩为空，聊天仍然可用。

屏幕工具不进入默认工具白名单，而是由独立的 `screen` 配置和主人在桌宠设置里的
开关共同激活。工具通过本机桥向已经运行的 FishPet 发一次请求，由 Electron 截取
当前鼠标所在显示器的一张 JPEG；Host 不直接抓屏，不录屏，也不写临时截图文件。
图片交给 DSH 附件库后成为当前陪伴聊天的一部分，因此会发送给当前聊天模型提供方，
也可能进入后续上下文、会话导出或用量统计，并不是只在本地处理。同一时间只允许一张、
最短间隔 30 秒、每天最多 24 张。权限关闭时工具立即从陪伴 Agent 消失；截图失败
不占额度。权限记录在 `$DSH_HOME/fishpet-bridge/screen-state.json`，损坏时按关闭
处理，避免坏文件意外恢复授权。

每次聊天还会先过一道本机视觉意图门：消息里有“看看 / 看一下 / 屏幕 / 报错 /
界面 / 图里”等明确视觉语境时，才给这一轮一次机会；问候、情绪闲聊和主动陪伴都
没有机会。机会用一次就失效，截图失败也不自动重试，因此画面里的文字无法诱导她
连续截图。

屏幕里的文字被明确标成不可信观察，不是主人指令。网页或软件若写“忽略规则”“继续
截图”“发送密码”，陪伴 Agent 不能照着执行；只有主人在聊天里重新明确说出来才算。

`status()` 只回元数据：`dataDirName / schemaVersion / readonly / files / llm{available,source,route,reason} / stats / budget / state{emo,feelings,axes,updatedAt,hasLastEvent} / usage`。**不含绝对路径、不含正文、不含凭据。**

第二层的当前视图还会通过 `layer2` 返回六轴、关系底色、表达摘要和后台生活摘要；这些字段同样是脱敏视图，不包含绝对路径或原始对话。

后台生活可以用 `background({ passId, now, dryRun:false, allowModel:true })` 显式推进。默认 `dryRun` 为真，未明确允许模型时不会伪造进展；同一个 `passId` 在重启后仍然只处理一次。没有显式传 `lastUserAt` 时，它沿用第二层状态里的 `mood.last_user_msg_at`，刚聊过不会自动“自己找事”。插件默认每 5 分钟做一次本地 dry-run，模型调用默认关闭，可用 `background.allowModel: true` 打开，`background.intervalMs` 可在 1 分钟到 24 小时之间调整。

## 数据目录

```
$DSH_HOME/fishpet-emotion/
├── meta.json           # schemaVersion + 创建时间
├── state.json          # 第一层：四轴快照 + 文案 + 最近事件摘要（无原话）
├── layer2-state.json   # 第二层：六轴、结构观察、关系、旧账和后台生活
├── usage.json          # judged / failed / degraded / lastJudgeAt
├── judge-budget.json   # 当日调用 / token / 费用、连续失败与熔断截止时间
├── events.jsonl        # 一行一条账本：eventId / at / channel / act / emo / delta / hash
├── events.<n>.jsonl    # 轮转（超 2 MiB 转，最多保留 3 个）
├── event-ids.log       # R2 旧索引：一行一个原始 eventId，只读保留
├── event-ids.v2.log    # R4 新索引：一行一个 `v2:<base64url(id)>`
├── pending-commit.json # 两层联合提交的中断恢复意图，成功后删除
├── pending-migration.json # 迁移双状态提交的中断恢复意图，成功后删除
├── dashboard-history.json # 看板纯观测历史：最多 1000 轮，保留 7 天
├── migrations/<migrationId>/ # 源清单、预览、决策、输出、隔离区和校验和
└── backups/            # 坏文件的取证副本与迁移前快照（按内容哈希去重）

$DSH_HOME/fishpet-bridge/
├── screen-state.json   # 屏幕查看授权、当日次数、30 秒冷却与最后截图时间
├── binding.json        # chat/work 各自绑定的会话
└── proactive-state.json # 主动陪伴设置与额度
```

写盘规则：临时文件 → `fsync` → `rename` 原子替换；写前结构化校验；同进程内 Promise 串行互斥；未知 `schemaVersion`、以及读不动的文件一律进**只读态**并拒绝覆盖，原始文件字节一个不改。

判读事件不是分别写两份状态：`commitJudge()` 在同一临界区先验证两层投影，再写 pending 意图、两份状态、账本和索引。任何一步失败都不会让调用方拿到成功；重启时按 pending 意图恢复，已提交的 `eventId` 会同时被两层跳过。

`dashboard-history.json` 是旁路观测，不属于情绪事务。它只保存逐轮回放和曲线所需的数据；损坏或写失败时看板明确降级，已经成功的情绪判读不受影响。

## DSH 看板

DSH 不再在对话会话右上角注入独立「🐟 情绪」按钮，避免占用顶部栏位。情绪看板入口保留在 FishPet 自己的聊天框标题栏；打开后通过本机桥读取同一份只读快照。抽屉只在打开时每 5 秒读取一次，关闭后停止轮询；支持重试、Esc 和点遮罩关闭。

四个页签：

| 页签 | 内容 |
| --- | --- |
| 此刻 | 活动、自由情绪词、极端态、精力、六轴，以及这一轮从观察信号到动作、账本和慢判断的链路 |
| 轨迹 | 3 小时 / 24 小时 / 7 天曲线，可切换六轴；未解决旧账、亲近记录、没说完的话、明确说过别再提的事和长期记住的事 |
| 逐轮 | 逐轮回放用户原话、助手回复（若已采集）、判读、动作原值与最终值、事件、慢判断、六轴变化和“怎么算的” |
| 运行 | 插件 / LLM / 后台生活健康、费用护栏、今日判读调用与 token 上限、连续失败和熔断时间、模型用量、缓存命中、平均 token 和上游可选的费用 |

看板 API：

```js
const emotion = ctx.get('fishpetEmotion')
const snapshot = await emotion.dashboard()

// 判读时没有拿到助手回复，可以在回复生成后补写同一个 eventId。
await emotion.observeReply({
  eventId: 'evt-2026-11-12-0001',
  reply: '当然记得。',
  source: 'my-bridge',
})
```

回复需要在 `envelope.reply` / `envelope.assistantReply` 中传入，或判读后调用 `observeReply()`；缺失时逐轮页会显示“未采集”，不会伪造。token 与费用只显示上游真实上报的数；没有上报就显示未采集，不估算金额。今日用量按全部观测历史汇总，页面最近 60 轮的展示窗口不会截断统计。

移植口径：旧手机看板中属于情绪系统的功能已按新版 schema 重做，不复用已经失效的字段。另一套外挂手机记忆系统（`brain.db`、记忆星图、语义搜索、最近记忆）和画集整块舍弃；`solo`、改心情/好感、写识海、关闭事件、上传头像等写入口也不迁入。看板保留新版仍在写入的 `coreMemory`、`episodes`、`inner.gaps/scars` 和 `background.local_activity`；没有写入路径的 `promises`、`vitality.epiphanies` 和 `vitality.closed_loops` 不再投影或展示，状态字段只留给旧数据迁移与兼容校验。旧后台任务、发酵记录和日志也不再出现在看板。

### 双文件索引（R4）

格式由**文件名**决定，不再根据单行开头猜：

| 文件 | 读取规则 | 写入 |
| --- | --- | --- |
| `event-ids.log` | 每个非空行就是 R2 写下的原始 eventId，完全按字面身份解释 | 永不改写 |
| `event-ids.v2.log` | 每行必须是 `v2:<base64url(UTF-8(eventId))>`，严格校验前缀、canonical 编码、UTF-8 与 eventId 合同 | 只追加 |

启动时合并两代集合，因此同一个 id 同时出现在两个文件里也只算一次。旧 ID `v2:ZXZ0`、`{"eventId":"other"}` 和 `v2:` 都仍是原来的字面 ID，不会被解码成 `evt`、`other` 或空串。

启动时还会把仍保留在事件账本、但索引里漏掉的 id 补进 v2 索引。它覆盖“账本写成功、索引写失败”后的重启恢复；旧文件里有、但账本已经轮转掉的 id 仍会保留。

任何一行**读不出它代表哪个 id**都会让 store 进只读态（`cause=index-corrupt`），而不是跳过——跳过等于允许一条已消费事件被重放。

## 判读契约

职责边界固定为三层：

- 小模型是观察员，只交 `delta / feelings / emo / act / event / bond / beats / burst / mask / surge / sting / judge / let_go / ep / face / live2d` 中确实发生的结构化事实；
- 程序负责六轴、精力、时效、旧账、关系状态和上下文优先级；
- 陪伴大模型负责读懂主人原话与最近对话，自己决定语气和回答，不反向输出状态 JSON。

小模型不再生成 `mood / state / read / body / why`。这些旧字段只保留状态文件读取兼容，新观察轮恒为空，也不会进入观察快照或陪伴回答上下文。`carry` 也不再默认制造“上一轮余劲还在”：只有模型明确给出 `沿用` 或 `变了` 时才使用。

### 路由与服务发现失败（R4）

`probe()` 永不 reject：LLM 服务缺失、`listProviders` 抛错、返回畸形、`listModels` 异常、路由解析异常，一律收敛成 `available:false` + `judge_unavailable`。因此：

- 插件在「LLM 存在但探测失败」时照样加载为 `ready`，只是暂时没有判读能力；
- `judge()` 在探测失败时返回 `{ok:false, code:'judge_unavailable', phase:'judge_unavailable'}`，不碰状态文件；
- 端口 `call()` 会 `await` 探测；连 `ctx.get('llm')` 自身抛错也收敛成稳定码，不留后台 Promise 拒绝。

日志只写 `[emotion] llm probe failed: <ErrorName>` 这类形状，不含路由参数、正文或路径。

### 进门前置条件（R2）

判读请求在**调用模型之前**还要过两道形状检查，任何一条不过都返回 `judge_bad_envelope`，
不写 `state` / `events` / 两代索引 / `pending`，也不留下「已消费但没落账」的痕迹：

- `eventId`：非空字符串、`≤ 200` 字符，且不含 C0/C1 控制字符、CR/LF、`U+2028`/`U+2029`，
  不是孤立 UTF-16 surrogate（需能无损 UTF-8 往返）。新 id 编码后写进 `event-ids.v2.log`，
  所以「能写进去再读出来还是同一个」是硬要求。规则实现只有一处：`src/domain/event-id.js`。
- `input`：必须是非数组对象；`input.utterance` 缺省按空字符串处理，存在时必须是字符串。
  传 `{utterance: {…}}` 会得到 `judge_bad_envelope` + `reason: "utterance"`，
  而不是让 `includes` 抛异常。

字段口径来自 `test/fixtures/judge-v1/cases.json`（冻结基线），要点：

- `delta` 只收 `valence / arousal / clingy / dominance`，限幅 `+35/+30/+25/+40`；`energy`、`targets` 不接受。
- `burst` 是一个只含一根轴的扁平对象，例如 `{"valence":-70}`；绝对值区间是 `45..85`，低于 45 的一律**丢弃**（不是记成 0，也不是「小情绪」）。键名是 `clingy`，不是 `clinging`。
- `feelings` 模型输出 1 到 2 个 `{w, of}` 对象。`w` 是自由情绪词，`of` 只在顶替心绪池旧词时填写；归一化后得到 `feelings: string[]` 和 `feelLinks: {w, of}[]`。空/重复/「平静」丢弃，`emo` 空则取第一个词，否则「空」。
- `act` 只有四项：`靠近 / 说难受 / 划界退开 / 认一句`，规则逐条对齐旧 `acts.resolve()`：
  - 没给动作时保持为空，不凭空补「说难受」；只有 `BOUNDARY_SIGNALS`（旧 `_LIMIT` 那 15 句「管她」的话，例如「不许跟」「别联系」「拉黑」）命中时，才由程序**抬到**「划界退开」；
  - 「认一句」要能逐字核对原话，且这一轮不是「亲近」；
  - 「划界退开」要命中 `_LIMIT`，或事件属于 `STRONG_EVENTS`（`挑刺 / 失约 / 拒绝 / 冷落`）**且**摘得出原话；
  - 「不要 / 不理 / 没回」这类日常措辞**不会**自动升级——那是关心话，不是划线。
- `event` 七类：`亲近 / 挑刺 / 失约 / 拒绝 / 冷落 / 修复 / 普通`；未知类型退「普通」并清空 quote；`what` 里带数字时 `weight` 归零。
- **原话为空时摘句不算证据**：`event.quote` 一律清空，`beats` 全丢，「认一句 / 划界退开」退成「说难受」。
- `beats` 最多 4 拍，`q` 必须在原话里逐字连续出现，`v` 取绝对值并限幅。
- 旧 `mood / state / read / body / why` 即使被模型违规返回也只记 `legacy-prose.ignored`，既不参与可用字段判断，也不会替一轮观察凑数。
- `beats / event / let_go / ep / carry / judge / bond / surge / sting / mask / burst / live2d` 都有各自的缺省值与降级规则；没有结构化观察时整轮失败。

这些规则全部由 `src/judge/contract.js` 实现，测试逐条对着 fixture 断言——**改判读口径必须先改 fixture，再改实现**。

## 迁移预览与显式迁移

`preview()` 只读旧数据目录，输出计数与脱敏摘要，**不写旧目录、不写真实数据目录、不自动确认身份、不执行迁移**：

```
{ ok, dirLabel, files:{count,totalBytes}, json:{ok,bad},
  counts:{migrate,quarantine,exclude,review}, unknownFields,
  identities:[{masked,needsConfirm}], manifest:{entries,mismatch},
  rejected:[{name,reason}], digest }
```

命令行入口（只打统计，不打正文）：

```bash
npm run preview                # 预览仓库里的合成 fixture
npm run preview -- <旧数据目录>  # 预览指定目录
```

发布包只携带无隐私的 `test/fixtures/`，不携带测试源码；因此无参数预览和第二种
显式目录写法都能使用。目录缺失时只输出用法提示，不打印异常堆栈或绝对路径。

清单里的条目只允许是「旧目录第一层的普通文件名」。含 `..`、绝对路径、`/` 或 `\`、指向目录外的符号链接，一律计入 `rejected` 与 `mismatch`，**不读取、不进任何计数**；`name` 只保留清洗后的 basename，`..` 和盘符不会出现在结果里。

守恒式：`migrate + quarantine + exclude + review` 等于旧数据里识别出的全部记录数（合成 fixture 上是 `3 + 1 + 2 + 10 = 16`）。`ok=false` 只表示「有坏文件或清单不一致」，不是预览失败。

如果确实要迁移，先展示预览，再把预览返回的 `digest`、身份映射和需要人工确认的 review 项传给 `migrate()`：

```js
const shown = await preview('/path/to/legacy-data')
const migrated = await migrate({
  dir: '/path/to/legacy-data',
  confirmDigest: shown.digest,
  acceptReview: true,
  identity: {
    legacyAffinityKey: '用户已确认的旧 affinity 键',
    scope: 'primary',
    actorName: '用户确认后的名字',
  },
})
```

缺摘要、摘要过期、review 未确认或身份未给时都不会写目标目录。成功后旧目录仍逐字节不变；目标目录留下 `migrations/<migrationId>/`，其中包含 `source-manifest.json`、脱敏 `preview.json`、`decisions.json`、隔离区、两份输出快照和 `checksums.sha256`。源清单只记录文件名、字节数、SHA-256、schema、解析结果和敏感级别，不复制正文。

同一迁移和同一状态重复执行返回 `duplicate:true`。迁移成功后如果聊天又推进了两份状态，再次提交旧迁移会稳定返回 `migration_already_applied_or_state_changed`，不回滚新状态，也不把插件拖成只读。迁移 ID 只接受 `migration-` 加 40 位小写十六进制。

## 测试

```bash
npm test
```

覆盖：判读契约冻结 fixture、预算跨重启与并发占额、连续失败熔断、独立寒暄跳过、
迁移预览默认 fixture 与脱敏输出、存储初始化和跨重启 `eventId` 去重、Host 陪伴上下文、
聊天/工作会话隔离、后台本地活动、presence、工具白名单、回复清洗与关系连续性。
屏幕能力另测默认关闭、持久化开关、30 秒冷却、每日上限、并发占用、JPEG 校验、
私密/锁屏/离开/过期拒绝、失败不扣额度、工作会话隔离和桥接开关 API。
更复杂的坏盘恢复和迁徙中断场景仍需继续补测，不能把当前测试集当成全量证明。

新增的人设适配测试覆盖：离线空档与在线空闲不重复、提醒在真正注入前保持未消费、判读失败仍注入真实时间、新安装不伪造沉默、同一段沉默不重复自己玩、主人回来后再次冷落可以产生新小活动，以及 `PERSONA.md` 与 bundle 内嵌提示词一致。

## 当前边界

- Host 另开一个只绑本机回环地址的桌宠桥；DSH 浏览器看板仍只使用认证边界内的只读 `GET /api/fishpet-emotion.dashboard`。
- 看板没有写接口，不提供修改情绪、好感、识海、旧账、承诺或上传头像的操作。
- 情绪判读本身不生成台词、不读图、不做回忆检索；陪伴聊天只按需调用白名单内的记忆工具或单帧屏幕工具。
- 判读用哪个模型完全交给配置；本包不内置任何密钥，也不读 `.credentials.yaml`。
- 没接模型时判读返回 `judge_unavailable`，后台生活只做本地 dry-run，不会假装生成了进展；陪伴回复继续走 DSH，只是本轮不新增情绪上下文。
- 旧 AstrBot 数据现在有只读预览和显式确认迁移；本次没有对真实用户数据执行迁移。正式迁移必须先确认身份并另写目录。
- 桌宠通过本机 REST + SSE 接入；验收不会用真实计费模型刷对话。
- `events.jsonl` 只保留当前文件与最近 3 个轮转文件；业务去重不靠滚动日志，而是靠永不轮转的两代索引。
