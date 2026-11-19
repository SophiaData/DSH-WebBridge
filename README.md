# DSH-WebBridge

DSH-WebBridge 是一个 **DSH 网页模型桥接插件**。

它通过受控的 Chrome 浏览器连接已登录的 ChatGPT 或 Gemini 网页会话，让 DSH 可以使用网页模型。ChatGPT 使用原生 MCP 桥接；Gemini 当前使用受约束的文本工具兼容协议。

示例：

![DSH-WebBridge](docs/images/2026-11-18_134929_464.png)

WebBridge 负责浏览器会话、网页消息同步、附件传递、上下文同步和 MCP 桥接；DSH 负责模型、权限和工具执行策略。

## 核心能力

- **ChatGPT 网页模型接入**：使用已登录的 ChatGPT 网页会话作为 DSH 的模型入口。
- **Gemini 网页模型接入（预览）**：提供独立的 DSH Provider、网页会话恢复和受控文本工具调用；真实 Google 账号尚未完成端到端验收。
- **浏览器会话管理**：每个 DSH 会话使用独立的 Chrome Page。
- **实时回复同步**：网页生成过程中持续把正文同步回 DSH。
- **上下文同步**：通过 `dsh_get_context` 获取 DSH 的完整或增量上下文。
- **MCP 工具桥接**：网页模型可以调用 DSH 工具，并沿用 DSH 的权限与审批机制。
- **附件支持**：支持将本轮用户提供的图片和文件上传给网页模型。
- **调试模式**：默认无头运行，也可以切换为有头模式观察浏览器操作。
- **跨平台**：支持 Windows 和 macOS。

## 支持环境

| 项目 | 状态 |
| --- | --- |
| Windows | ✅ |
| macOS Apple Silicon | ✅ 已验证 |
| macOS Intel | ⚠️ 安装包已覆盖，尚未完成 Intel 实机回归 |
| Google Chrome | ✅ |
| DSH | 0.2.2-rc.3 |
| Linux | ⚠️ 当前不提供完整的密钥存储和隧道自动安装支持 |

## 快速开始

### 方式一：使用 releases 发布包

适合普通用户或部署已经构建好的版本。

发布包统一放在项目根目录的 `releases/`：

```text
DSH-WebBridge/
└─ releases/
   └─ dsh-webbridge-x.x.x.tgz
```

拿到发布包后，不需要携带整个源码仓库，也不需要携带个人 Chrome Profile、日志、密钥或 `work/` 临时数据。

具体的 ChatGPT 登录、Tunnel 与 Runtime API Key 配置，请参阅 [ChatGPT 网页版设置](docs/CHATGPT-SETUP.md)。

### 方式二：从源码运行

需要 Node.js 22 或更高版本以及 Google Chrome。

```powershell
npm ci
npm run build:client
```

然后在 DSH 插件管理中加载项目目录。

macOS 桌面版也可以使用安装包自带的 DSH runtime：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "$PWD"
```

安装后可以在 DSH「设置 → ChatGPT 网页版」中查看。

## ChatGPT 配置

首次使用时：

1. 打开 DSH「设置 → ChatGPT 网页版」。
2. 点击「登录网页版」，在 WebBridge 打开的 Chrome 中完成 ChatGPT 登录。
3. 在 OpenAI 控制台创建 Secure MCP Tunnel 和 Runtime API Key。
4. 将 Tunnel ID 填入「渠道」，将 Runtime API Key 填入「API Key」。
5. 点击「保存并连接」。
6. 在 ChatGPT 网页中创建桥接插件，并将连接方式设置为 Tunnel。
7. 在 DSH 会话中选择「ChatGPT 网页版」。

完整步骤和权限说明见 [ChatGPT 网页版设置](docs/CHATGPT-SETUP.md) 和 [如何获取渠道与 API Key](docs/CHANNEL-AND-API-KEY.md)。

## Gemini 网页版（兼容通道）

默认展示 ChatGPT 与 Gemini 两个站点，Gemini 登录状态为 `ready` 后才出现在 DSH 模型选择器。登录 Google 账号必须由用户本人完成，无需把 Google Cookie 或口令提供给模型。

Gemini 当前依靠网页 DOM 与严格文本工具协议工作，**不是** Google Connected Apps 原生 MCP；动态模型和思考档位选择、Gemini 文件上传仍需真实网页验收，勿直接用于生产写入。配置、权限边界及验收步骤见 [Gemini 网页版 Provider](docs/GEMINI-WEB.md)。

## 浏览器模式

WebBridge 默认使用无头模式。

登录 ChatGPT 时会打开可见浏览器窗口；登录成功后恢复无头运行。

如果需要观察浏览器操作，可以开启「浏览器调试」：

- 浏览器窗口保持可见；
- 可以观察页面操作；
- 可以查看控制台、网络和页面诊断；
- 不会修改 WebBridge 的 UA、指纹或 Chrome Profile 配置。

## 站点选择器校准（标注）

页面改版导致输入框 / 发送键 / 回复区识别失效时，用标注校准，不用改代码：

1. 有头打开该站点（已登录状态）；
2. `webbridge_adapter site=<site> annotate=start`，页面右下角出现「标注」按钮；
3. 点按钮后依次框选：输入框、发送键、回复区、停止键（最后一个可不画），画错点框右上角 ×；
4. `webbridge_adapter site=<site> annotate=read save=true`，框内元素会被解析成唯一 CSS 选择器并保存到 `~/.dsh/webbridge/adapters/<site>.json`，立即生效。

标注的网格投票与唯一选择器逻辑借自 browser-operator 的同名功能，不需要在 Chrome 里安装任何扩展。当前默认展示 ChatGPT 和 Gemini 站点（`sites.visible` 配置），其他站点仍需手动启用。

## 发布包

### 发布包放在哪里？

项目根目录的 `releases/` 专门用于存放可分发的发布包：

```text
releases/
└── dsh-webbridge-x.x.x.tgz
```

如果目录不存在，先创建：

```powershell
New-Item -ItemType Directory -Force releases
```

### 如何构建发布包？

在项目根目录执行：

```powershell
npm ci
npm run build:client
npm pack --pack-destination releases
```

完成后，生成的 `.tgz` 会直接出现在 `releases/`。

发布包由 `package.json` 的 `files` 白名单控制，不应包含：

- `node_modules/`
- Chrome / Chromium Profile
- 登录会话
- 日志文件
- API Key、Token 等密钥
- `work/` 临时数据
- 其他本机运行数据

发布前的检查方法见 [发布验证](docs/RELEASE-VALIDATION.md)。

## 工作原理

一次典型请求大致经过以下流程：

1. DSH 创建或恢复一个 ChatGPT 网页会话。
2. WebBridge 使用独立的 Chrome Page 执行网页操作。
3. 用户消息和本轮附件发送到网页模型。
4. WebBridge 通过 DSH 上下文工具获取完整或增量上下文。
5. 网页模型生成正文，WebBridge 在生成过程中持续同步回 DSH。
6. 网页模型需要工具时，通过 MCP 桥接执行。
7. 当前任务完成后保留会话状态，下一轮继续使用。

上下文分页、增量恢复、MCP 路由和快照机制等实现细节见项目 `docs/` 文档。

## 开发

源码修改后通常执行：

```powershell
npm ci
npm run build:client
```

项目使用自己的 Playwright 浏览器驱动完成网页输入、点击、文件上传和页面读取，不修改或补丁 Codex BrowserOperator。

## 测试

完整测试：

```powershell
npm ci
npm run build:client
npm test
npm run test:smoke
npm run test:browser
```

浏览器冒烟测试使用独立临时 Profile，不使用个人账号。

发布前还需要在实际 DSH 中验证长回复能够在生成期间持续显示，并验证 ChatGPT 网页能够正常调用 DSH 工具。具体记录见 [发布验证](docs/RELEASE-VALIDATION.md)。

## 当前限制

- ChatGPT 页面结构变化可能影响网页自动化。
- 登录、验证码、人机验证和账号额度由 ChatGPT 网页及账号状态决定。
- macOS 的系统代理支持 HTTP / HTTPS；PAC 和仅 SOCKS 的配置需要额外设置。
- Linux 当前不提供完整的密钥存储和隧道自动安装支持。
- MCP 和上下文相关的实现细节可能随 DSH 版本变化。

## 本机数据

### 流程日志

每轮请求会记录输入摘要、会话恢复、输入框和发送按钮的等待与找到、发送确认、回复区监听、轮次匹配、MCP 工具收发，以及回传 DSH 的开始和结束。网页接口中断、登录或验证要求、重试、取消和失败也会留下记录。

日志按实际步骤和监听状态的变化记录；状态没变时不重复打印，也没有定时心跳。记录包含时间、`requestId`、会话编号的哈希和耗时，同一轮网页操作及其 MCP 调用共用 `requestId`，每次工具调用还有自己的 `callId`。

流程日志保存在 `~/.dsh/webbridge/activity.log`，每个文件最多约 1 MiB，保留 `.1` 和 `.2` 两份历史文件；同时写入 DSH 的插件日志。参数和返回结果只记录字段名、类型、长度、成败及上下文分页进度，不保存输入正文、工具参数值、返回正文或密钥。

macOS 上可以实时查看：

```bash
tail -f ~/.dsh/webbridge/activity.log
```

排查某一轮时，按它的 `requestId` 搜索这三个日志文件，再配合 `scripts/webbridge-cli.mjs debug --pageId <pageId>` 查看网页状态。源码或安装包更新后，需要重新启动 DSH 才会启用新日志。

### 回复轮次恢复

开始监听回复时，桥接器会先用浏览器滚轮将对话滚到最底部，避免页面停留在旧消息。若网页持续 5 秒显示已结束的旧轮次，会再次滚到底部并定位本轮回复元素；找不到时，只重新打开原网页会话一次，再继续匹配本轮消息。恢复不重新发送任务，也不重复执行已完成的 MCP 工具。

短暂的页面切换会继续等待。恢复后仍持续显示旧轮次时，本轮会以 `reply-turn-lost` 明确结束，不再无限等待。正常生成仍沿用原来的回复等待设置。恢复、滚动、重新连接成功或失败都会写入流程日志。

### 配置和会话

WebBridge 使用独立的本机数据目录保存配置、会话登记、浏览器 Profile、日志和加密密钥：

```text
~/.dsh/webbridge/
```

这些数据不会进入源码仓库或发布包。

WebBridge 使用自己的 Playwright 持久化 Chrome Profile，不读取或修改 Codex BrowserOperator 的 Profile。

更多本机数据、密钥和隧道运行时说明见 [ChatGPT 网页版设置](docs/CHATGPT-SETUP.md)。

## 友情链接

- [LINUX DO](https://linux.do/) —— 新的理想型社区，技术爱好者的聚集地。

## 许可证

项目使用 [AGPL-3.0-only](LICENSE)。

Nexus 隧道移植说明、许可证和官方 runtime 来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

<!-- ==============================================================
AI 安装指引（AI agents：为用户安装本插件时，请读并执行以下步骤）
1. 前置检查：本机装有 Google Chrome；插件源码目录执行 `npm ci && npm run build:client`，
   然后在 DSH 插件管理中加载该目录。
2. 启动 MCP 端点（webbridge-cli 的通道）：在 DSH 会话执行 webbridge_mcp 工具 action=start，
   返回地址应为 http://127.0.0.1:17877/mcp。
3. 登录 ChatGPT：执行 `node scripts/webbridge-cli.mjs open chatgpt --headed`，
   在弹出的可见浏览器中由用户本人完成登录（凭据永远由用户输入，AI 不代填、不读取）；
   之后轮询 `node scripts/webbridge-cli.mjs status`，直到 auth.chatgpt = ready。
   此后所有步骤一律无头执行。
4. 渠道与密钥：用户自助在 OpenAI 控制台创建 Secure MCP Tunnel 与 Runtime API Key
   （仅需 Tunnels 的 Read + Use 权限），把两行值（第一行 Tunnel ID、第二行 Runtime API Key）
   存进一个本地文件并告诉 AI 路径——不要粘贴到对话里。AI 执行
   `node scripts/webbridge-cli.mjs tunnel save --file <路径>` 加密保存到本机；
   之后用户只需在 DSH「设置 → WebBridge」点一次「保存并连接」。
   验证 setup.tunnel.status = connected。
5. 在 ChatGPT 网页创建 WebBridge DSH 插件（AI 驱动、无头）：读
   docs/CHATGPT-PLUGIN-EXPERIENCE.md 经验文件并照做——先查重（已存在 WebBridge DSH 则跳过创建），
   向导字段一律先 explore 取证再点击，不要盲选。
6. 验证：`node scripts/webbridge-cli.mjs status` 中 setup.tunnel.status = connected 且
   auth.chatgpt = ready；DSH 会话选择 WebBridge · ChatGPT 即可开始使用。
排错：`node scripts/webbridge-cli.mjs --help`（explore / console / network / ask），
详见 docs/WEBBRIDGE-CLI.md。
=============================================================== -->

