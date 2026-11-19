# Gemini 网页版 Provider（兼容通道）

此功能把登录后的 `https://gemini.google.com/app` 网页作为 DSH WebBridge 的模型 Provider。它与 ChatGPT 现有原生 MCP/Tunnel 通道彼此隔离。

## 当前交付范围

- DSH 设置页默认可显示 `gemini` 站点，模型菜单在站点登录状态为 `ready` 后才暴露 `webbridge-gemini / gemini-web`。
- 沿用 Playwright 浏览器驱动与 DSH Session；每个 DSH Session 绑定独立的 Gemini `/app/<会话ID>` URL。
- 网页回复读取使用 `user-query`、`model-response`，排除思考内容与历史嵌套容器。发送确认优先采用用户消息身份；不确定是否送达时拒绝盲目重发。
- 常规文本支持正文逐步回传。工具调用以 **显式** `<<<TOOL_CALLS>>>` 协议解析，在 DSH 工具执行器里按原有权限执行；无权限工具在产生执行块之前即被拒绝。
- 对话初始化把系统背景、有限工具 Schema 与此前历史作为**文本**发送给 Gemini，不依赖 ChatGPT 的上下文 TXT 上传与 OpenAI Secure MCP Tunnel。
- 本轮用户的文件附件走通用附件路径，该上传行为仍需真实 Gemini 网页验收。

## 使用方式

1. 在 DSH WebBridge 设置中选择 Gemini（默认显示）；通过插件已有的站点登录功能，**由本人**在独立浏览器 Profile 内完成 Google 登录，切勿向 Agent 提供口令、Cookie 或二次验证码。
2. 确保状态 `auth.gemini === 'ready'`；选择 DSH 模型 `WebBridge · Gemini`。当前模型目录为单个泛用网页模型，**不表示已经实现网页模型/思考等级自动切换**。
3. 先做普通问答与第二轮追问；再用只读工具（例如读取指定测试文件）验收一次工具调用闭环；真实写操作另行审批。
4. 若网页改版，先在可见调试模式检查/校准 `gemini` 的输入框、发送键与回复区，不要直接修改 ChatGPT 的选择器。

## 工具协议与权限

网页模型**必须只在需要工具调用时**完整输出下面两个标记包裹的 JSON 数组，例如：

```text
<<<TOOL_CALLS>>>
[{"name":"read","arguments":{"file_path":"/approved/example.txt"}}]
<<<END_TOOL_CALLS>>>
```

其他回复可直接使用普通文本，或用 `<<<FINAL>>>` 与 `<<<END_FINAL>>>` 包住最终答复。只有完整、格式合法、工具名位于本轮 DSH 工具清单中的调用才会被发出为 DSH tool-call。嵌入普通 Markdown 的 JSON 示例不会被执行。调用仍须通过 DSH 原有工具授权、审批和审计，网页没有权限修改 DSH 的权限策略。

默认工具 Schema 最多传递本轮前 16 个（可通过 Provider 配置调整）；上下文总长默认最多 32000 字符，超过时显式报错而非截断工具参数。因 Gemini 网页没有通用的原生上下文工具，本方案会把部分上下文与工具结果发送给 Google，必须避免发送敏感文件或密钥。

## 官方 Gemini Connected Apps 原生 MCP：尚未实现

本 PR **不是** Google Connected Apps 集成。Google 提供自定义 MCP App 连接功能，但要求符合条件的账号与受支持地区，并有服务端要求。官方文档：

- [Google Gemini 自定义 Connected Apps](https://support.google.com/gemini/answer/17209137)
- [Connected Apps MCP 服务器规范](https://developers.google.com/connected-apps/mcp/server-optimization)
- [Gemini Developer Mode 验收](https://developers.google.com/connected-apps/mcp/dev-mode/usage)

后续若实现官方 MCP 通道，需要独立完成并验收：公网 HTTPS MCP 终端、OAuth 客户端/令牌安全、Google 支持的 MCP 协议版本（当前文档指定 `2025-11-25`）、最小工具白名单、Session/上下文绑定、审计、故障与重试策略。不能把现有本地 `127.0.0.1:17877/mcp` 或 OpenAI Secure Tunnel 的可连接状态视为 Google 已能连接。

## 验证范围与待验收项

不需要 Google 账号的本地自动化测试包含：严格协议解析、未知工具阻断、DSH 工具结果跨轮回传、Gemini 新会话 URL、旧回答防误判、流式输出、Gemini 工具协议禁止预先流出为正文、ChatGPT 回归。通过命令：

```bash
npm ci
npm test
npm run test:smoke
npm run build:client
git diff --check
```

**上线前必须人工真实验收**：

- Google 登录状态识别及登录后模型菜单可见性
- `/app` 新会话实际置空及 `/app/<id>` 跨轮恢复
- Gemini 多行 Quill 输入、发送键与回复内容 DOM（不同语言/页面改版）
- 短回复、长回复、代码块、连续工具调用及网络中断恢复
- 只读工具授权及一项经过批准的写操作；重复发送与历史回复不得重放工具
- DSH 重启后的会话持久化；ChatGPT 通道不受影响
- 如果要启用官方 MCP：使用 Gemini Developer Mode 单独完成协议、OAuth、Schema 与工具执行验收

未完成这些真实验证前，不应标记为生产可用。
