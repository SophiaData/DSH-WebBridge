# 渠道策略（Channel Strategy）

本目录存放各网页渠道的**模型获取策略**。核心原则：`session.js`、`provider.js`、`index.js`
等核心流程不出现任何 `site === 'xxx'` 分支，一切站点差异通过策略对象获得（策略模式）。

## 策略标准（先满足规范，再填充实现）

一个网页渠道在插件里由三部分组成：

| 部分 | 形态 | 位置 |
| --- | --- | --- |
| **DOM 定位策略** | 数据驱动（选择器），可用 `webbridge_adapter annotate` 在真实页面校准 | `src/config.js` 的 `SITE_PRESETS[site].adapter` |
| **登录判定策略** | 数据驱动（composer 可见 = ready；登录控件 / /login、/sign_in = needs-login） | `src/setup-browser.js` |
| **模型获取策略** | 代码（本目录，每渠道一个文件） | `src/models/<site>.js` + 注册表 `src/models/index.js` |

## ModelSource 策略接口

每个文件导出一个类，构造与方法的契约如下：

```js
export class XxxModels {
  constructor({ settings, driver, log = () => {}, onChange = () => {} }) {}

  // 扁平目录：每个「模型 × 思考档位」一条。没有档位概念的渠道给 power: 0 单条。
  // 绝不导航离开当前会话页面；需要开新页探测时用 driver.exclusive + 专用 sessionKey。
  // 目录真正变化时才持久化并触发 onChange()。
  async list(force = false) {
    return [{ key, modelName, power, label, effort, preferred }]
  }

  // 在页面上应用 { modelName, power }。不支持切换的渠道对不匹配项抛
  // model-unavailable，绝不静默换模型。
  async select(choice) {}

  // 目录变化时调用，宿主用它发 llm/models-updated 刷新 DSH 模型菜单。
  onChange()
}
```

约定：

- `key` 用 `paidModelKey(modelName, power)` 生成（chatgpt.js 导出），保证模型 id 稳定；
- `provider.listModels` 把目录按 `modelName` 分组、`choices[].power/label` 变成思考档位；
- 注册表没有的站点返回 `null`，provider 自动回落为单条通用模型（现行为，不造假目录）；
- 每个策略必须有不依赖真实账号的单测（mock driver，参考 `scripts/session-sites-unit.mjs`）。

## 新增渠道步骤

1. `src/config.js` 加 `SITE_PRESETS` 条目（DOM 定位默认值）；
2. 本目录新建 `<site>.js` 实现 ModelSource——页面内选择器探测的参考 `chatgpt.js`，
   URL 可直接推导模型名的参考 `bigmodel.js`；
3. `src/models/index.js` 注册表挂上该渠道；
4. 单测覆盖 `list`/`select` 契约，`npm test` 全绿。

## 当前实现

- `chatgpt.js` — 参考实现：打开网页模型菜单，逐模型读取名称与思考滑块档位，支持 select。
- `bigmodel.js` — 智谱体验中心：`?modelCode=` 决定当前模型，目录从 URL 推导；
  页内模型下拉的 DOM 探测（chatgpt.js 的 trigger→open→names 模式）待在真实页面校准后补上。
- `gemini.js` — Gemini 网页模式菜单：`bard-mode-menu-button` 打开 `gem-mode-menu`，
  读取 `gem-menu-item[role="menuitemradio"]` 作为模式列表，支持按菜单项切换。
