# DSH WebBridge 网页模型 Provider

当前默认展示 ChatGPT 与 Gemini 两个站点，但可用模型仍受账号登录状态及各站点网页兼容性的限制。

| provider id | 网页模型 | 工具通道 |
| --- | --- | --- |
| `webbridge-chatgpt` | ChatGPT 网页版 | ChatGPT 原生 MCP → WebBridge → DSH 原工具执行器 |
| `webbridge-gemini` | Gemini 网页版（预览） | 严格文本工具协议 → DSH tool-call chunks → DSH 原工具执行器 |

其他历史站点预设保留，但不默认暴露，也未完成本次验收。Google AI Studio 与 Gemini 网页版是不同站点，不能混用选择器和账号状态。

## 与 DSH LLM 接口

来源是当前安装的 `@deepseek-ai/dsh-llm` 的 `LlmAdapter` 基类。主入口按站点创建 Provider，保留独立的 `ChatSession` 和 `WebChatAdapter`：

- `providerInfo`：Provider 标识与显示名
- `listModels`：从已登录的站点目录选择模型；Gemini 暂使用单个泛用模型
- `resolveModel` / `prepareCall`：准备模型、推理档位与调用参数；Gemini 不进行未验证的网页档位切换
- `stream` / `generate`：将网页回复转换成 DSH 文字块或工具调用块

### ChatGPT 路径（保持原行为）

1. 每个 DSH Session 恢复独立的 ChatGPT 网页会话。
2. 输入框只发送新增用户内容及短上下文引用；网页侧使用 `dsh_get_context` 读取完整或增量上下文。
3. ChatGPT 原生 MCP 工具调用经 WebBridge 到 DSH 工具执行器。
4. 网页正文在生成期间流式同步回 DSH，支持取消与旧轮次恢复。

### Gemini 路径（本次新增的兼容实现）

1. 只在 `auth.gemini === 'ready'` 时显示模型，模型 id 为 `gemini-web`。
2. `/app` 作为空白聊天路由，`/app/<id>` 作为保存的聊天路由；各 DSH Session 独立管理。
3. 使用 Gemini 原生 DOM：`user-query` 与 `model-response` 读取用户轮次及回复；拒绝把旧回复当成本轮结果。
4. 初始化将受限长度的 DSH 背景、已授权工具 Schema 和历史直接放进 Gemini 输入框，不依赖 ChatGPT 的 TXT 附件上传。
5. 普通正文可按生成进度同步；只有完整、合法的 `<<<TOOL_CALLS>>>` 数组会被解析成 DSH tool-call chunks。未列在本轮工具目录中的调用立即拒绝，所有工具实际执行仍经过 DSH 原生策略。
6. 工具结果进入下一轮新增输入，不重复投递完整历史；模型输出截断和超过上下文阈值的请求显式失败。

**限制：** Gemini 原生 Google Connected Apps MCP 未连接；真实 Google 登录、网页模型选择、附件行为、DOM 变更兼容和长任务稳定性还需实机验证。详情参阅 [Gemini 网页版 Provider](GEMINI-WEB.md)。

## 验收条件

- ChatGPT 原有 MCP、会话、模型目录和流式回归测试保持通过。
- Gemini 未登录时不暴露模型；登录后可单独选择。
- 每个 Session 正确记住 `/app/<id>`，旧轮次和历史版本不能触发重复工具调用。
- JSON 示例、不完整标记、无效参数和未授权工具不能被执行。
- 正文流式同步不会泄漏工具协议前缀，也不会误发工具调用。
- 通过单元、冒烟与浏览器实测之后，才能宣称生产可用。
