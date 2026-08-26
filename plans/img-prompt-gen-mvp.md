# 生图 Prompt 词库 Chrome 插件 MVP 实施蓝图

## 1. 目标与当前状态

目标：从空目录搭建一个最小但真实可用的本地生图 Prompt 词库，跑通以下闭环：

```text
网页选中文字
  → Chrome 本地暂存
  → 127.0.0.1 本地服务
  → 原始收录/词条/配方/常用 Prompt 真源
  → 数据门禁与运行时编译
  → 健康接口回读
  → Chrome 侧栏搜索与复制
```

当前状态（2026-08-22）：

- 工作目录为空，没有现有代码、`AGENTS.md`、测试或数据。
- 当前目录不是 Git 仓库；计划按直接模式执行，不假设分支或 PR 流程。
- 本机当前是 Node.js `v23.11.1`、npm `10.9.2`，并已安装 Google Chrome。Node 23 已停止维护，实施前切换到 Node 24 LTS；`package.json` 固定 `engines.node >=24 <25`。
- Chrome 官方当前支持 MV3 的 `contextMenus`、`storage` 和 `sidePanel` API。因为右键后要调用 `sidePanel.open()`，最低版本固定为 Chrome 116，而不是只满足基础侧栏能力的 114。

## 2. MVP 边界

### 必须包含

- Manifest V3 扩展。
- 选中文本右键收录，先写 `chrome.storage.local`，再尝试同步。
- 明确区分：已同步、仅本地暂存、内容为空、同步失败。
- Chrome 侧栏支持搜索、分类筛选、新增、编辑、删除、复制、手动重试同步。
- 本地服务仅绑定 `127.0.0.1`。
- `captures.jsonl`、`terms.json`、`recipes.json`、`prompts.json` 四类真源。
- `runtime/library.json` 为编译产物，不允许人工直接编辑。
- 数据结构校验、原子性/引用门禁、运行时编译、健康接口与自动测试。
- 真实接口回读和 Chrome 手动验收说明。

### 明确不做

- 登录、账号系统、云同步、付费、随机抽取、多人协作。
- 自动图片反推、自动拆词、LLM 在线调用。
- 保存 Cookie、账号、浏览历史、完整网页或默认保存网页 URL。
- 复杂框架、数据库、容器化、后台常驻守护进程。
- 为追求词数自动制造同义词，或把机器校验冒充人工审核。

## 3. 技术与安全决策

### 技术栈

- 扩展：原生 HTML/CSS/JavaScript，MV3 module service worker，无打包步骤。
- 服务：Node 24 LTS 的内置 `http`、`fs/promises`、`crypto`，不引入 Web 框架。
- 测试：Node.js 内置 `node:test` 与 `assert`。
- 数据：可读 JSON/JSONL；JSON 更新采用临时文件加原子重命名，写操作串行化。

选择原因：仓库为空且目标是本机单用户 MVP。该方案能直接加载、容易审计、依赖少，也能把扩展逻辑拆成纯函数进行自动测试。

### 固定边界

- 默认服务地址：`http://127.0.0.1:43119`；端口被占用时拒绝启动，不自动把正文发往未知端口服务。
- `manifest.json` 设置 `minimum_chrome_version: "116"`，只声明 `contextMenus`、`storage`、`sidePanel`、`clipboardWrite`；host permission 只允许 `http://127.0.0.1/*`。
- 服务成功绑定端口后才显示有时效的高熵配对 secret；该 secret 不通过 HTTP 发送。侧栏用 Web Crypto 与服务完成 nonce + HMAC challenge-response，并验证服务返回的 server proof 后才保存 bearer token。服务端 secret/token 文件权限设为 `0600`，扩展只存 `chrome.storage.local`，服务同时绑定本次配对的扩展 Origin。未验证 server proof 前不发送任何正文；每次 API 请求同时校验 token、协议版本、Host 和已配对的 `chrome-extension://<id>` Origin。无 Origin 只在显式测试模式开放；项目自带 CLI 回读脚本从本机私密配置读取 token 与已配对 Origin，不要求用户把 token 写进 shell history。
- 配对 secret 10 分钟失效、最多尝试 5 次；`npm run pairing:reset` 可撤销已有 token 并生成新 secret，用于扩展卸载重装、storage 清空或扩展 ID 变化。
- 服务拒绝非回环 Host；写请求要求 JSON 和固定协议头，限制请求体大小，并拒绝普通 `http(s)` 网页 Origin。威胁模型明确：防普通网页和端口冒充，不承诺抵御已经获得本机文件读取权或浏览器扩展权限的恶意程序。
- 收录正文以 UTF-8 实际字节计数，上限 48 KiB，请求体上限 64 KiB；扩展与服务使用同一规则。`trim()` 只用于判空，落盘必须保留用户选中的原文，不截断、不悄悄去空白。
- 扩展生成稳定 `captureId`，terms/recipes/prompts 也使用客户端生成 ID；创建操作幂等。相同 ID + 相同内容返回原结果，相同 ID + 不同内容返回 `409`。
- PATCH/DELETE 携带 `expectedRevision`（或 `If-Match`），防止多个侧栏实例覆盖新数据。
- 已同步队列立即清除正文，只保留短期收据；收据最多保留 200 条或 24 小时。未同步正文保留到成功、用户删除或卸载扩展，并显示占用空间与失败原因。
- 不存 `pageUrl`、页面标题、HTML、Cookie 或浏览历史。只存用户主动选择的文字、创建时间、来源类型、同步/整理状态和追溯 ID。

## 4. 目录与职责

```text
AGENTS.md                     项目规则、真源、隐私、测试和完成标准
README.md                     安装、启动、使用、验收与故障排查
package.json                  Node 脚本，无运行时第三方依赖
docs/
  data-contract.md            字段、枚举、状态机、迁移规则
  organizing-protocol.md      原子词/配方/Prompt 的人工整理规则
extension/
  manifest.json
  service-worker.js           菜单创建、收录、队列与重试编排
  sidepanel.html
  sidepanel.css
  sidepanel.js                UI 事件与渲染
  lib/
    capture-queue.js          可测试的队列状态机
    api-client.js             本地服务请求与错误归一化
    library-model.js          搜索、筛选、表单校验
    review-model.js           整理工作台与人工审核状态
server/
  index.js                    仅负责启动与信号处理
  app.js                      HTTP 路由、CORS/Origin、错误响应
  config.js                   回环地址、端口、大小限制
  storage.js                  JSON/JSONL、原子写入、串行化
  transaction.js              进程间锁、WAL、崩溃恢复
  schemas.js                  字段与枚举校验
  library-service.js          CRUD、引用保护、候选快照校验
  compiler.js                 真源到 runtime 的纯函数编译
  pairing.js                  一次性配对码与 bearer token
data/
  CURRENT                     最后提交成功的全局 sourceRevision 标记
  captures.jsonl              原始收录真源
  terms.json                  原子词真源
  recipes.json                组合配方真源
  prompts.json                常用 Prompt 真源
  runtime/library.json        派生运行时
  .secrets/client-token       本机配对密钥，0600，不提交/不导出
scripts/
  check-contracts.js
  check-syntax.js
  validate-data.js
  compile-runtime.js
  smoke-server.js
  health.js
  read-library.js
  pairing-reset.js
tests/
  fixtures/                   隔离数据，不污染真实 data/
  unit/
  integration/
plans/
  img-prompt-gen-mvp.md       本计划
```

## 5. 数据契约（实施时固化在 `docs/data-contract.md`）

### 原始收录 `captures.jsonl`

首行是元数据 `{"recordType":"meta","schemaVersion":1}`，之后每个 capture 保留一条当前快照：

```json
{
  "recordType": "capture",
  "id": "cap_<uuid>",
  "text": "用户主动选择的完整原文",
  "capturedAt": "扩展首次暂存的 ISO-8601 时间",
  "receivedAt": "服务首次落盘的 ISO-8601 时间",
  "sourceType": "browser_selection",
  "processingStatus": "pending_review",
  "processedAt": null,
  "derivedTermIds": [],
  "derivedRecipeIds": []
}
```

`processingStatus` 只允许 `pending_review | processed | needs_review`。原文不可被摘要替换；整理只补状态与派生引用。首次收录可追加；后续状态更新在可恢复事务内重写完整 JSONL，不能追加第二条同 ID“状态事件”。尾部残行、重复 ID、同 ID 不同正文都必须阻断读取并给出恢复指引。

### 原子词 `terms.json`

核心字段：`id`、`name`、`category`（给人浏览）、`responsibility`（真实视觉职责）、`sourceCaptureIds`、`review`、`createdAt`、`updatedAt`。

- 一个 term 只能控制一个可独立增删、替换或锁定的可见变量。
- 浏览分类与视觉职责独立校验，不能互相自动推导。
- 长度限制是 UI 门禁，不是原子性判断。MVP 先设显示名最多 24 个 Unicode 字符，配置集中管理。
- `review.machine` 与 `review.human` 分开记录；机器状态由每次校验重新计算，不能信任文件中手写的“通过”。人工批准保存 `approvedContentHash`、`approvedAt` 和 `reviewer=local_user`，把批准绑定到当时内容。
- 任意进入下述 canonical approval payload 的字段发生变化，都会自动撤销旧批准并回到 `human=pending`。

批准 hash 使用确定性 canonical JSON：字符串先做 Unicode NFC；对象键按字典序；无语义顺序的 ID 集合排序；有语义顺序的数组保持原顺序。`id` 不可变但不参与 hash；时间戳、revision、review 和机器结果不参与 hash。三类发布载荷固定为：

- term：`name`、`category`、`responsibility`、排序后的 `sourceCaptureIds`。
- recipe：`name`、保持顺序的 `termIds`、`derivedPrompt`、排序后的 `sourceCaptureIds`。
- prompt：`title`、`text`、`sourceType`，以及存在时排序后的 `sourceCaptureIds`。

任一载荷字段变化都会撤销该实体批准。term 变化还会在同一事务中把引用它的 approved recipes 降为 pending，并把受影响列表返回 UI；若数据绕过 API 手改后出现“approved recipe 引用未发布 term”，全量验证直接失败。

### 组合配方 `recipes.json`

核心字段：`id`、`name`、`termIds`、`derivedPrompt`、`sourceCaptureIds`、`review`、时间字段。

- `termIds` 必须精确引用现有 term。
- 配方保存多个控制轴共同成立时的关系；图片反推或案例复刻的完整 Prompt 放在 `derivedPrompt`，不进入 `prompts.json`。该字段是整理当时的不可变快照；需要修改时创建新 revision 并撤销旧批准。
- 已批准配方如果引用未批准 term，编译必须失败并报告路径，不能生成半悬空运行时。

### 常用 Prompt `prompts.json`

核心字段：`id`、`title`、`text`、`sourceType=manual`、`review`、时间字段。

- 只保存用户主动录入、会直接复制复用的完整 Prompt。
- 图片反推、批处理和测试生成内容不写入这里。

### 运行时 `runtime/library.json`

- 包含 `schemaVersion`、`sourceRevision`、`sourceContentHash`、`generatedAt`、已发布的 terms/recipes/prompts 和各类计数。
- 只由编译器生成；编译顺序为“读取真源 → 全量验证 → 引用校验 → 发布门禁 → 写临时文件 → 原子替换”。
- 首次生成前，示例数据保持 `human=pending`；不得为了让侧栏有内容而伪造人工审核。用户明确批准至少一个公开示例后，才进入正式运行时。

### 审核与发布状态矩阵

| 状态 | 真源是否保留 | 工作台是否可见 | 是否进入 runtime | 编译行为 |
|---|---:|---:|---:|---|
| 结构非法/悬空引用 | 否 | 返回字段错误 | 否 | 整体失败，不落盘 |
| `human=pending` 且机器通过 | 是 | 是 | 否 | 合法，正常排除 |
| `human=needs_revision` | 是 | 是 | 否 | 合法，正常隔离 |
| `human=approved` 且 hash 匹配、机器通过 | 是 | 是 | 是 | 正常发布 |
| approved recipe 引用未发布 term | API 正常编辑时自动把 recipe 降为 pending；手工坏数据保留待修 | 是 | 否 | API 返回受影响项；全量校验遇到坏数据则失败 |
| 内容已改但仍携带旧批准 hash | 否 | 返回“批准已失效” | 否 | 新变更失败或自动降为 pending 后要求重审 |

这里的关键区别是：**合法 pending 不会让编译失败，只是不进入 runtime；结构错误或发布不变量破坏才会失败。**

### 多文件一致性

- 不宣称多个文件能靠 rename 获得文件系统级原子提交。
- 所有服务读取、服务写入和 CLI 脚本必须共享同一个独占 revision lock；MVP 为简单可靠而串行化短时读取，任何 GET 都不能越过正在提交的事务读取文件。
- 每次跨文件变更先在 `.txn/<transactionId>/` 写好候选文件、hash 和 WAL manifest，并 fsync；随后按 manifest 推进替换。服务在事务完成前不返回成功。
- 进程崩溃后，下一次启动必须在监听端口前完成 roll-forward 或从备份 rollback；无法恢复则只读启动，`/health` 返回 `degraded`，所有写接口返回 `503`。
- `data/CURRENT` 在所有候选文件替换成功后最后更新；每个 JSON 顶层 revision、JSONL meta revision 和 runtime sourceRevision 必须与它一致。
- 每个 GET 在拿到 lock 后只读取一次 CURRENT revision 对应的完整快照；runtime 的 `sourceRevision/sourceContentHash` 必须与当前真源匹配。不匹配时 `/health`、workbench、CRUD GET、export 和 `/api/library` 都返回 degraded/503，不得拼出半新半旧响应。

## 6. 本地 API 契约

统一响应：成功 `{ "ok": true, "data": ... }`；失败 `{ "ok": false, "error": { "code", "message", "nextAction", "fields" } }`。

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/pair/challenge` | 返回一次性 nonce、serviceId、protocol；不返回配对 secret |
| `POST` | `/api/pair/complete` | 验证 HMAC proof，返回 token 与可由扩展验证的 server proof |
| `GET` | `/health` | 未认证只返回服务 identity/protocol/pairing 状态；认证后再返回真源/运行时分开计数、待整理数、revision 与运行时生成时间 |
| `POST` | `/api/captures` | 幂等写入主动选择文本 |
| `GET` | `/api/captures?status=pending_review` | 侧栏查看待整理原料 |
| `DELETE` | `/api/captures/:id` | 用户删除原始正文；有派生引用时返回 `409` 并列出引用 |
| `GET` | `/api/workbench` | 返回 pending/needs_revision 的 terms、recipes、prompts 与 captures |
| `POST` | `/api/captures/:id/organize` | 一次提交派生 terms/recipe 和 capture 状态/反向引用 |
| `GET` | `/api/library` | 回读正式运行时 |
| `GET/POST` | `/api/terms` | 查询或新增原子词真源 |
| `PATCH/DELETE` | `/api/terms/:id` | 编辑或删除；被配方引用时删除返回 `409` |
| `GET/POST` | `/api/recipes` | 查询或新增组合配方 |
| `PATCH/DELETE` | `/api/recipes/:id` | 编辑或删除配方 |
| `GET/POST` | `/api/prompts` | 查询或新增常用 Prompt |
| `PATCH/DELETE` | `/api/prompts/:id` | 编辑或删除常用 Prompt |
| `POST` | `/api/:collection/:id/review` | 用户明确批准或标记 needs_revision；服务计算并绑定内容 hash |
| `GET` | `/api/export` | 导出四类真源和 schema/revision，不包含服务 token |

除配对 challenge/complete 和 `/health` 的最小身份信息外，所有接口都要求配对 token、已绑定 Origin 和协议头；`/health` 未认证时不得泄露计数或文件状态。所有真源变更先在内存候选快照上完成全量验证和编译预检；预检失败不落盘。成功后通过 WAL 可恢复事务更新真源和 runtime，响应带新 `sourceRevision` 与 `runtimeGeneratedAt`。`organize` 必须校验 capture 的 `derived*Ids` 与派生实体的 `sourceCaptureIds` 双向一致，不能只更新一边。

## 7. 分阶段实施步骤

### Step 1：建立项目契约与可运行骨架

依赖：无。

上下文：空仓库最容易在后续出现“多个真源”“生成物被手改”“验收口径漂移”。第一步先冻结边界和脚本入口。

任务：

1. 创建 `AGENTS.md`，明确目录所有权、真源/派生物、隐私边界、禁止覆盖、测试和完成标准。
2. 切换/安装 Node 24 LTS；创建 `README.md`、两份 `docs/` 契约文档和 `package.json`，固定 `type: module` 与 Node engines。
3. 创建所有 data 文件的 schemaVersion 与最小公开示例；人工审核状态保持真实。
4. 创建真实可执行的 `check:contracts` 脚本，只检查目录、JSON/JSONL 元数据和契约文件；其余脚本在对应实现步骤加入，不留会假通过的空壳。
5. 若用户希望开始版本管理，单独确认后再初始化 Git；本步骤不擅自创建远端或提交。

验证：

```bash
node --version
npm run check:contracts
```

退出标准：新执行者只读 `AGENTS.md`、README 和数据契约，就能说清每个文件能否人工编辑、哪些数据绝不能保存、怎样才算完成。

回滚：只删除本步骤新增的空骨架和示例，不触碰之后可能产生的用户数据。

### Step 2：实现数据校验、存储和运行时编译器

依赖：Step 1。

上下文：侧栏和 API 都依赖稳定数据契约。先做纯数据层，可避免 UI 先行后反复改字段。

任务：

1. 实现四类真源的解析、字段/枚举/UTF-8 字节与 Unicode 显示长度校验。
2. 实现 captures 首次追加、按 ID 幂等检查、JSONL 尾残行检测；状态更新以快照重写且保留原文。
3. 实现所有读写共用的进程间 revision lock、WAL 候选目录、fsync、roll-forward/rollback 启动恢复；服务与 CLI 共用同一实现，GET 只能读取一个 committed revision。
4. 实现 term 原子性门禁的结构部分、分类/职责枚举、同名规范化查重提示。
5. 实现 recipe 引用完整性、删除保护、双向追溯和批准状态传播校验。
6. 按三类 canonical payload 实现审核 hash 与状态矩阵；合法 pending 被排除而不是报错，语义编辑自动撤销旧批准，term 变化级联降级依赖 recipes。
7. 实现只发布合格内容的 runtime 编译器和 sourceRevision/contentHash 一致性检查。
8. 为所有规则写单元与故障注入测试，覆盖每个 WAL/rename 崩溃点、并发 mutation 与恢复；测试使用临时目录。

验证：

```bash
npm run validate
npm run compile
node --test tests/unit/storage.test.js tests/unit/compiler.test.js tests/unit/schemas.test.js
```

退出标准：有效 fixture 能稳定编译；合法 pending 能留在真源但不发布；长文本伪装成 term、重复 ID 冲突、悬空引用、伪造/过期批准和非法枚举都产生确定且可定位的失败；逐个故障点重启后要么完整 roll-forward，要么完整 rollback。

回滚：WAL 保留旧文件备份直到 CURRENT revision 提交；恢复过程优先 roll-forward，候选损坏时 rollback。恢复失败进入 degraded，只读保护，不能继续写。

### Step 3：实现只监听回环地址的本地服务

依赖：Step 2。

上下文：服务是扩展与文件系统之间唯一写入边界，必须先证明安全、幂等和可回读，再接浏览器。

任务：

1. 实现 `server/app.js`、nonce/HMAC 双向证明配对流程和全部 API 路由；配对 secret 只在 bind 成功后显示，不进入 HTTP 响应或日志。
2. 启动时强制绑定 `127.0.0.1`；配置为 `0.0.0.0` 时直接拒绝启动。
3. 实现配对 secret 的 10 分钟有效期、5 次尝试限制、server proof 验证、token/Origin 绑定，以及 `pairing:reset` 的撤销与重新配对流程；正文请求发出前必须完成双向证明。
4. 校验 token、协议版本、Host、Origin、Content-Type、请求体大小、必填字段和文本字节数；生产模式拒绝无 Origin。
5. 标准化 400/401/404/409/413/422/500/503 错误及 `nextAction`。
6. 实现 `/health` 与 `/api/library` 真实磁盘回读，不从过期内存伪造成功；revision/hash 不一致返回 degraded/503。
7. 写集成测试：配对、恶意/缺失 Origin、端口身份失败、收录、重复重试、CRUD、乐观并发、整理事务、审核、引用删除冲突、失败不改盘、健康计数。
8. 创建 `smoke-server.js`、`health.js`、`read-library.js`、`pairing-reset.js` 及对应 npm entries；smoke 自动在测试进程启动服务、探测并关闭，health/library 脚本安全读取本机 token 与 Origin。

验证：

```bash
node --test tests/integration/server.test.js
npm run smoke:server
```

退出标准：服务只出现在 `127.0.0.1:43119`；同一 capture 重试两次只落一条；失败请求不改变真源或 runtime；健康计数与磁盘一致。

回滚：停止服务只停止新请求；数据回滚由 WAL 恢复完成，不能把“停止服务”描述成数据回滚。

### Step 4：实现 MV3 右键收录与离线队列

依赖：Step 3。

上下文：MV3 service worker 会休眠，不能依赖常驻内存。队列状态必须完全落在 `chrome.storage.local`，并可在下一次事件中恢复。

任务：

1. 创建最小权限 `manifest.json`、module service worker、侧栏入口和真实可执行的 `check-syntax.js`/`npm run check:syntax`。
2. 安装时创建仅对 `selection` 生效的“保存到生图词库”菜单。
3. context-menu handler 在用户手势仍有效时先立即调用 `sidePanel.open()`，再执行 storage 或网络 await。
4. 点击后只用 trim 结果判空；为空则不入队并给出“内容为空”，非空原文不得被 trim 改写。
5. 非空文本先持久化为 `queued`；本地写失败或 quota 超限时不发送网络，并明确提示“未暂存、未发送”。
6. 配对成功并验证 server proof 后再调用 `/api/captures`；未配对、secret 过期、token 被撤销或扩展重装时侧栏停在重新配对指引，不发送正文。
7. 实现 `queued → syncing → synced` 与失败状态机，加入 single-flight、`attemptId`/version guard；扩展重启时把 stale `syncing` 恢复为 `queued`，旧响应不能覆盖新成功。
8. 用 captureId 幂等重试；`runtime.onStartup`、`runtime.onInstalled`、侧栏打开和用户点击“重试”时恢复队列，不额外申请定时器权限。
9. 同步成功后删除本地正文，只保留限量短期收据；失败保留原文、错误代码、次数和下一步。
10. 不注入网页脚本，不读取页面其他内容；所有不可信正文只能用 `textContent`/DOM 节点渲染，禁止 `innerHTML` 和 inline handler。
11. 将队列状态机、API client 与 Chrome API 编排分离，使用 fake adapters 测试双向配对、错误 server proof、token 撤销、扩展重装、storage 失败、quota、并发 drain、响应前/后 worker 终止和 stale syncing 恢复。

验证：

```bash
node --test tests/unit/capture-queue.test.js tests/unit/api-client.test.js
npm run check:syntax
```

退出标准：服务在线且已配对时新收录最终为 synced；服务离线时刷新页面或重载扩展后队列仍在；恢复服务并重试后不重复写入；worker 任意终止后无永久 syncing；正文不会因队列收据长期累积；四种用户状态均有明确文案。

回滚：禁用/移除扩展不会影响已落盘数据；未同步内容仍在扩展本地存储，除非用户主动卸载扩展。

### Step 5：实现侧栏检索、分类和 CRUD

依赖：Step 3、Step 4。

上下文：正式词库与待整理原料不能混为一种内容。UI 要让用户一眼看出条目类型、发布状态和同步状态。

任务：

1. 侧栏分为“正式词库”“整理工作台”“本地暂存”“编辑/审核”四块，不用 popup 作为主界面。
2. 正式词库从 `/api/library` 读取；支持按类型、浏览分类、关键词筛选及复制。
3. 整理工作台从 `/api/workbench` 读取 pending/needs_revision 的 captures、terms、recipes、prompts；新建 pending 内容保存后必须仍可找到、编辑和审核。
4. 从某条 capture 发起整理，一次提交派生 terms/recipe；UI 展示并校验双向追溯，成功后原 capture 标记 processed。
5. 新增/编辑表单明确选择 `term | recipe | prompt`；term 同时填写浏览分类与视觉职责；客户端生成稳定 ID 以支持重试。
6. 提供明确的“人工批准”“需返修”动作和确认文案；批准由服务计算内容 hash。修改已批准内容后 UI 立即显示批准失效并回到 pending。
7. 删除 term/capture 如有引用，展示 409 的引用列表，不做静默级联删除；提供不含 token 的数据导出和隐私删除说明。
8. 所有保存显示 sourceRevision、runtime 生成时间或待审核状态；未批准条目不声称已在正式词库。
9. UI 状态包括未配对、加载、空列表、服务离线/degraded、校验失败、并发冲突、保存成功、复制失败。
10. 对搜索、筛选、表单和审核模型写纯函数测试；DOM 测试确认正文仅按文本渲染；关键 Chrome 交互保留可重复手动清单。

验证：

```bash
node --test tests/unit/library-model.test.js tests/unit/review-model.test.js
npm run check:syntax
```

退出标准：用户能完成搜索、分类、新增、编辑、删除、复制；原料、草稿、待审核和正式运行时条目不会被同一状态文案混淆。

回滚：前端失败不修改数据；API mutation 失败时保留表单输入并显示下一步。

### Step 6：补齐单元/服务集成验证与可观测性

依赖：Step 2–5。

上下文：“文件存在”不是成功。需要从收录输入一直证明到 runtime 和 API 输出，同时诚实区分自动测试与人工 Chrome 验收。

任务：

1. 建立完整 `npm run verify`：JSON/manifest 校验、JS 语法、单元测试、服务集成测试、数据校验、临时数据编译。它不命名为浏览器 E2E。
2. 测试在线收录状态机、空文本、离线暂存、恢复同步、CRUD、乐观并发、整理/审核、引用冲突、编译门禁和 health 计数。
3. 测试不得写真实 `data/`；所有服务测试使用临时目录和随机端口。
4. 增加故障注入：WAL 各阶段崩溃、并发 mutation、重复 POST 响应丢失、stale syncing、storage quota、恶意 Origin、过期 token 和不可信正文渲染。
5. 为服务输出精简结构日志，不打印完整 Prompt、配对码或 token，只记录 requestId、动作、实体 ID、状态码和耗时。
6. README 提供真实回读命令、常见错误、token 排除规则、原始数据导出/删除和加密备份建议。

验证：

```bash
npm run verify
npm run smoke:server
```

退出标准：一条命令可重跑所有自动验证；测试失败能定位到具体门禁；日志不泄露用户正文；接口返回值与磁盘 runtime 一致。

回滚：测试环境完全隔离；关闭服务后无后台进程继续写文件。

### Step 7：Chrome 真实手动验收与 MVP 收口

依赖：Step 6；还依赖用户对至少一个公开示例词给出真实人工批准。

上下文：自动测试不能替代 Chrome 权限、菜单、侧栏与持久化行为的人工验收。执行者不得声称自己已操作用户的 Chrome，除非确实完成。

任务：

1. 终端 A 启动本地服务，记录一次性配对码；端口占用时先处理，不切换到未知端口。
2. 打开 `chrome://extensions`，启用开发者模式，加载 `extension/`，在侧栏完成配对。
3. 使用公开测试文字：

   > 一名短黑发女性俯卧在浅青绿色碎花床铺上。镜头从近距离高位斜着俯拍，双臂在脸下交叠。窗边局部高曝光，画面低对比、轻微柔焦。

4. 在线右键收录：确认侧栏显示 synced，`captures.jsonl` 有且仅有一条完整原文。
5. 停止服务后再收录一段：确认仅本地暂存；重启服务并手动重试，确认补写且不重复。
6. 按整理协议人工拆出 5–20 个可独立控制的 term，并保存一个 recipe；不确定项留 pending review。
7. 用户在整理工作台明确审核并批准至少一个公开 term，例如“近距离高位斜俯拍”；确认保存后 runtime 自动重新编译。
8. 从 `/health`、`/api/library` 和侧栏分别搜索该词，核对同一 ID、分类、职责和生成时间。
9. 按固定格式报告：本轮检查原始收录数、新增 term 数、复用/重复数、新增/更新 recipe 数、完整 Prompt 数、待复核数、悬空引用数、人工通过数、机器通过数、进入 runtime 的 term 数、自动测试、health 回读、安装步骤、测试文本、三个位置的预期/实际结果、尚未完成的人工步骤。

验证：

```bash
npm run verify
```

终端 A：`npm run start`。终端 B：使用项目提供的已认证 `npm run health` 和 `npm run read:library`，避免把 token 直接写进 shell history。

人工检查：重新加载扩展、重启 Chrome 后已同步词仍能从 runtime 找到；未同步队列在扩展仍安装时不丢失。

退出标准：文章定义的 8 项最小闭环全部有证据；自动测试与人工验收分开报告；没有把 pending/机器通过描述成人工通过。

回滚：若真实验收失败，保留 capture 原文和队列，回到对应步骤修复；不要通过直接编辑 runtime 掩盖问题。

## 8. 依赖图与可并行性

```text
Step 1 契约骨架
  └─ Step 2 数据层与编译
       └─ Step 3 本地 API
            ├─ Step 4 右键收录/离线队列
            └─ Step 5 侧栏 CRUD（可先做数据模型，最终联调依赖 Step 4）
                 └─ Step 6 单元/服务集成验证
                      └─ Step 7 Chrome 人工验收
```

- Step 4 与 Step 5 在 API 契约冻结后可部分并行，避免同时修改 `manifest.json`、`sidepanel.js` 和共享 client；最终由一个步骤统一联调。
- 其余步骤串行更安全，因为后一步直接消费前一步的数据和接口契约。

## 9. 关键风险与防错门禁

| 风险 | 门禁 |
|---|---|
| “已保存”但服务未落盘 | 先本地入队；只在 API 成功并回读 ID 后标记 synced |
| 重试造成重复 capture | 扩展生成 captureId；服务幂等检查 |
| 未知进程占用固定端口并窃取正文 | 正文发送前完成一次性码配对；每次验证 token、协议与服务 identity |
| 普通网页或其他扩展调用本地接口 | 只绑定回环；固定已配对 Origin；token/Host/JSON/协议头校验 |
| 多文件写到一半崩溃 | 进程间锁、WAL、候选文件、fsync、启动恢复；不宣称多文件 rename 原子 |
| 长 Prompt 混进 terms | 结构/长度门禁加人工原子性协议；不确定即 pending |
| 配方引用悬空 | 变更前全量引用校验；被引用 term 禁止删除 |
| runtime 比真源旧 | sourceRevision/contentHash 比对；不一致时 library 503、health degraded |
| pending 让编译永久失败 | 状态矩阵明确“合法但不发布”；仅结构/发布不变量错误阻断 |
| 机器通过冒充人工审核 | 两套独立状态；批准绑定内容 hash；语义编辑自动撤销批准 |
| 测试污染私人数据 | 临时目录、fixtures、随机端口；禁止测试写 `data/` |
| service worker 休眠丢状态 | 持久化队列、single-flight、attemptId、stale syncing 恢复、幂等重放 |
| 本地 storage 被 synced 正文撑满 | 成功后删除正文；收据按 24 小时/200 条清理；quota 失败时不发网 |
| Prompt 在侧栏触发 stored XSS | 只用 textContent/DOM 节点，不使用 innerHTML；保留 MV3 默认 CSP |

## 10. 需求追踪矩阵

| 文章要求 | 数据/API/UI 落点 | 自动证据 | 人工证据 |
|---|---|---|---|
| MV3 可加载 | `manifest.json`，Chrome 116+ | manifest/语法检查 | `chrome://extensions` 卡片无错误 |
| 选中文字右键保存 | contextMenus + capture queue | fake Chrome adapter 状态机 | 网页真实右键出现菜单并回显状态 |
| 离线不丢、恢复同步 | storage.local + 幂等 capture API | offline/stale/重复响应测试 | 停服务收录，重启后重试 |
| 服务只监听本机 | server config + pairing | bind/Origin/token 集成测试 | health 显示 loopback，端口检查 |
| 侧栏搜索/分类/CRUD/复制 | library/workbench API + sidepanel | model/DOM/API 测试 | 每项真实操作一次 |
| 四类真源分层 | data contract + organize transaction | schema、追溯与编译测试 | 对照 capture、term、recipe、prompt |
| 原子词与配方门禁 | schemas + review hash + compiler | pending/approved/悬空引用测试 | 人工做替换判断并批准 |
| 健康接口与 runtime 回读 | revision/hash + `/health`、`/api/library` | smoke:server | 已批准新词三处同 ID 回读 |
| 机器/人工状态诚实 | 独立 review 状态与最终报告模板 | 伪造/过期批准测试 | 用户点击批准；报告分别计数 |

## 11. 完成定义

只有同时满足下列条件才算 MVP 完成：

1. `npm run verify` 全部通过。
2. 服务实际绑定 `127.0.0.1`，`/health` 和 `/api/library` 回读成功。
3. Chrome 能加载扩展，选中文本后能看到右键入口。
4. 在线收录、离线暂存、恢复同步和幂等重试均有证据。
5. 侧栏的搜索、分类、新增、编辑、删除、复制均验证。
6. 四类真源与 runtime 分层清晰，runtime 可重复生成且不能人工编辑。
7. 真实长 Prompt 保留原文，至少拆出 5 个合格 term 并保存 1 个 recipe。
8. 至少一个经用户真实批准的新 term 能从原始追溯、runtime/API 和侧栏三处回读。
9. 最终报告明确区分自动测试、机器校验、人工审核和仍需用户完成的 Chrome 操作。

## 12. 计划变更协议

- 新需求先判断是否破坏真源、隐私、最小权限或完成定义。
- 修改数据字段时先更新 `docs/data-contract.md`，再加迁移/兼容测试，最后改实现。
- 插入步骤时必须写清依赖、验证和回滚；不能只添加模糊的“优化”。
- 若 Chrome API 或 Node 版本边界发生变化，优先更新兼容性说明和测试，不静默扩大权限。
- 登录、云同步、付费、随机抽取、多人协作等超出 MVP 的功能另开计划，不塞入本蓝图。
