# 双站点并发与会话隔离 — Issue #2 技术方案

> 状态：设计评审中（文档阶段，不代表功能已实现）  
> Issue：[ #2 ](https://github.com/SophiaData/DSH-WebBridge/issues/2)  
> 范围确认：2026-11-19  
> 基线：`main` @ `fb193e8f46506d0cbcca2977a48a03f4e0049039`

## 1. 目标与非目标

**目标**：在同一个 DSH WebBridge 安装中，使用各一个已登录的 ChatGPT 与 Gemini 账号，允许不同 DSH 会话同时生成、调用各自获准的工具、取消和恢复，且不串 Page、消息、工具结果或会话上下文。

首版采用 **一个 WebBridge 自有的持久化 Chrome Profile / Context + 多个独立 Page**。不同网站保持各自站点登录态；不在本次实现 Profile 隔离。

**非目标**：
- 同一站点多个账号并行、账号切换、多个 Profile/Context/Chrome 进程。
- 生成过程中要求完成新的可见登录；首版先在空闲时分别登录两个站点。
- 改造 Gemini 为 Google Connected Apps 原生 MCP；继续使用当前受约束的文本工具协议。
- 自动代填凭据、绕过验证码、扩张工具权限、改变站点策略模型。
- 顺手重构 BrowserDriver、改写不相关业务流程或发布生产版本。

## 2. 现状与核查证据

| 位置 | 已核对事实 | 设计影响 |
| --- | --- | --- |
| `src/driver.js` | `AsyncLocalStorage` 维护当前 `sessionKey`；`sessionPages` 映射到 Page，`exclusive` 按 Key 排队 | 保留 Page/队列地基，但必须确认所有调用路径提供真实 Key |
| `src/session.js` | Provider 的 `ask` 可通过 `options.sessionKey` 构造 `site:sessionKey`；未提供 Key 时回落为 ChatSession 实例 Key | Provider 与公开工具路径须分别测试，不能误认为已全面隔离 |
| `src/ops.js` | `open`、`adapter`、部分 `browser` 操作固定使用 `__webbridge_default__`；`ask/send/read` 未统一接收 DSH 会话参数 | MCP 调用者身份不能自然传递到浏览器 Page |
| `src/mcp.js` | `dsh_get_context` 和 `dsh_context_id` 可绑定 DSH 会话；对一组 `webbridge_*` 工具有全局 `browser-busy` 门禁，且调用 `ops` 时未提供路由身份 | 不得简单删除门禁；先证明准确路由、防重入及权限语义 |
| `src/driver.js` 登录模式 | `open(headed)` 通过 `closeContext()` / `ensureContext(true)` 切模式，生成中拒绝切换 | 首版要求登录先于并发运行；不把“生成中登录”列为验收条件 |
| `docs/GEMINI-WEB.md` | Gemini 当前是受约束的文本工具协议；真实 Google 账号端到端尚未完成验收 | 必须单列真实 Gemini 验收，不能靠 mock 声称生产可用 |

上述是基线代码和文档的静态证据，**不是**双站点端到端通过的证据。

## 3. 最小架构与身份契约

```text
DSH session A ── Provider(ChatGPT) ─┐
                                    ├─ WebBridge: site + sessionKey → 专属 Page → Chrome Context
DSH session B ── Provider(Gemini) ──┘                           （单个持久 Profile）
                      │
                      └─ Gemini 文本工具协议 → DSH 授权工具执行器
ChatGPT 网页原生 MCP → dsh_get_context / dsh_context_id → DSH 授权工具执行器
```

四个身份**不能混用**：

1. **DSH sessionId**：用户会话的稳定身份；不同 DSH 会话必须隔离。
2. **context_id**：当前 DSH 请求所交付的 MCP 上下文路由凭据，可在请求边界更新；不是长期 Page ID。
3. **sessionKey**：浏览器队列与 Page 的所有权键，建议由 `site` 与稳定 DSH sessionId 组成；不得回落到全局默认 Page 执行其他会话的请求。
4. **pageId**：BrowserDriver 内部 Page 引用；仅在已验证所有者匹配时可执行会改变状态的操作。

**执行约束**：
- 同一 `sessionKey` 的发送、导航、取消和页面写操作串行；不同 Key 可并行。
- 每次 MCP DSH 工具调用在调用时验证 `context_id → sessionId`，并核对**当前活跃请求**。过期、缺失、跨会话、冲突的路由必须拒绝；绝不凭全局 `activeSessionId` 猜测。
- `webbridge_*` 浏览器工具与 DSH 工具不是同一类调用：浏览器工具必须有明确的调用者会话和可操作目标；对回调当前 WebBridge 所驱动的网页模型的自递归 `webbridge_ask/agent/send` 仍须拦截。
- 外部 MCP 工具依旧经过白名单、`toolScope.execute`、原有 DSH allow/deny/ask 审批与上下文检查；路由字段在交给业务工具前剥离。
- 不用站点名特判安全策略；站点功能差异继续走 `SITE_PRESETS` / model strategy。

## 4. 实施拆分（每阶段独立 PR）

### PR 1 — 本文档（当前阶段）

**文件**：新增 `docs/plans/concurrent-agents.md`；更新 Issue #2 的确认范围与验收标准。

- [ ] 对照既有源代码，记录“已实现”与“尚未验证”的边界。
- [ ] 固定单 Profile / ChatGPT + Gemini 的 MVP 范围。
- [ ] 明确下面两个开发 PR 的独立验收门槛。
- [ ] 文档评审后再开始运行时代码改动。

### PR 2 — MCP/操作路由与安全闸门

**主要文件**：`src/mcp.js`、`src/ops.js`、`index.js`；仅在测试证明必要时变更 `src/dsh.js`。  
**测试文件**：`scripts/mcp-unit.mjs`、`scripts/context-mcp-unit.mjs`、`scripts/context-lifecycle-unit.mjs`。

- [ ] 编写失败测试：两个活动 DSH 请求分别使用不同合法 context_id，分别能命中对应会话；交换 context_id 应被拒绝。
- [ ] 编写失败测试：未绑定/过期 context_id、同一 MCP 连接重新绑定冲突、context checkpoint 未完成时不能执行。
- [ ] 编写失败测试：`webbridge_*` 会话浏览器操作不能触及默认 Page；禁止自递归启动同一网页模型。
- [ ] 以**明确的请求路由参数**贯通 MCP → ops → BrowserDriver，而不是解除全部 `browser-busy`。
- [ ] 同会话重入保持阻断/排队；不同会话仅在身份、操作目标和安全条件均已确认后并行。
- [ ] 验证业务工具参数没有 `dsh_context_id`，DSH 权限审批链未绕过。
- [ ] 限定改动范围，更新相关文档，完成独立安全 review。

**验收命令**：`npm test`、`npm run test:smoke`、`git diff --check`。  
**通过标准**：以上负例全部失败关闭，现有 legacy 和 stateless MCP 路由测试无回归；代码审查确认没有跨 session 回落。

### PR 3 — Page 并发与登录生命周期

**主要文件（以失败测试定位为准）**：`src/session.js`、`src/driver.js`、`src/setup-browser.js`。  
**测试文件**：`scripts/session-sites-unit.mjs`、`scripts/browser-driver-smoke.mjs`、`scripts/gemini-provider-unit.mjs`、`scripts/context-provider-unit.mjs`。

- [ ] 编写失败测试：两个不同 DSH sessionId（ChatGPT / Gemini）同时生成，保留独立 Page、回复与持久 URL。
- [ ] 编写失败测试：取消 A 不影响 B；A 的 generation watch、会话关闭、重连不修改 B 的状态。
- [ ] 编写失败测试：相同账号不同 DSH 会话也不会复用彼此网页对话；相同 sessionKey 仍串行。
- [ ] 先登录、再并发；运行中要求 `headed`、切全局 debug mode 或关闭 Context 时不得静默关闭正在生成的 Page；暂不能安全执行时返回可诊断错误。
- [ ] 只有失败测试证明确有问题时才修改生命周期逻辑；不引入每站点 Context。
- [ ] 检查会话登记与恢复：重启/异常退出不把 A 的 URL、工具结果或取消信号指向 B。
- [ ] 独立 QA 与安全 review，保留现有重复发送保护。

**验收命令**：`npm test`、`npm run test:smoke`、`npm run test:browser`、`npm run build:client`、`git diff --check`。

## 5. 实际双站点验收（最后的合并门槛）

必须在用户本人已登录的 ChatGPT 与 Gemini 网页上开展，不触碰真实凭据；所有测试记录注明日期、机器/Chrome/DSH/WebBridge 版本、实际结果。

| ID | 场景 | 预期 |
| --- | --- | --- |
| E01 | ChatGPT A 正在输出长回复，Gemini B 发出独立问题 | 两者同时推进，页面和回复对应正确 |
| E02 | 两个会话各自调用一项授权的只读工具 | 工具结果、日志和上下文只进入其所属会话 |
| E03 | A 取消生成，B 正在回复 | 仅 A 被取消，B 正常完成 |
| E04 | A 的 context_id 传给 B、过期 context_id、无 context_id | 明确拒绝，不尝试自动选当前会话 |
| E05 | 同一 DSH 会话快速连续操作、不同 DSH 会话同时操作 | 同会话有序；不同会话不因全局门禁互卡 |
| E06 | 登录完成后关闭并恢复 WebBridge / DSH | 各会话 URL 和登录状态正确，不重发已确认发送的消息 |
| E07 | A 在生成时请求新的可见登录/全局调试模式切换 | 安全拒绝或延后，不中断 A、B |
| E08 | Gemini 多轮问答与受约束文本工具调用 | 正确完成；不把它误称为 Google 原生 MCP |

完成 E01–E08 的真实记录前，**不得**将本 Issue 标记为生产验收通过。

## 6. 分支、提交与合并纪律

- 每个 PR 聚焦一个责任边界：文档 → 路由安全 → 并发生命周期；不得合成一个大 PR。
- 实施时坚持测试先失败、最小修改、测试转绿，按“测试 / 实现 / 文档”构成有意义的小提交。
- PR 描述必须列出变更范围、风险、测试命令及结果、待人工验证项；不得把未运行测试写成 PASS。
- 安全相关 PR 必须有独立只读 Review，发现 P1 或跨会话串线则不合并。
- 不因本方案文档合并而默认授权自动发布、登录、执行生产写操作或关闭安全门禁。

## 7. 设计复审重点（进入 PR 2 前）

1. 证明具体哪条真实调用链受当前 `browser-busy` 阻断。**如果仅 Provider 两会话并发已可用，不应为此放开 MCP 浏览器工具**。
2. 明确外部 MCP 调用 `webbridge_*` 时如何识别请求来源和对应 Browser Page；无法可靠绑定就继续拒绝。
3. 检查 `ChatSession.enqueue` 的 fallback 会话键能否导致跨 DSH 会话串行或串页，做到按调用路径分开修复。
4. 不通过临时新 Context 绕过 Chrome 持久 Profile 登录状态；生成中重新登录不属于首版验收。
5. 对 `context_id` 的有效期、重复使用、checkpoint 状态和授权边界进行负例测试。

**完成定义**：不是“两个 Tab 都打开”，而是“两个 DSH 会话持续并发、权限正确、取消与恢复互不影响”，并有真实网页验收记录。
