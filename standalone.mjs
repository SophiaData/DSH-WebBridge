/**
 * WebBridge 独立宿主（standalone）— 不依赖 DSH 的常驻 MCP 端点。
 *
 * 与 DSH 插件的关系：
 *   - 复用 src/ 下的 config / driver / session / ops / mcp（这些模块本身零 DSH 依赖）
 *   - 不加载 src/dsh.js（DSH 工具转发）、不建 ContextStore（DSH 上下文）、不注册 cordis 插件
 *   - 因此只暴露 webbridge_* 本机工具；DSH 工具与 dsh_get_context 在本模式下不可用（设计如此）
 *
 * 与 DSH 内置端点的互斥：
 *   - 同一个 17877 端口只能有一个 MCP 服务；启动前探测占用，被占（例如 DSH 会话里执行过
 *     webbridge_mcp action=start）则直接退出并提示，避免两个进程抢同一 Chrome Profile。
 *
 * 数据与鉴权：
 *   - 与 DSH 共用 ~/.dsh/webbridge（chrome-profile / adapters / mcp-token.key），
 *     所以各客户端已有的 Bearer 不需要改。
 *
 * 用法：node standalone.mjs [--port 17877] [--debug]
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { resolveSettings, ensureDirs } from './src/config.js'
import { BrowserDriver } from './src/driver.js'
import { ChatSession } from './src/session.js'
import { createOps } from './src/ops.js'
import { McpBridge } from './src/mcp.js'
import { createModelSources, modelSourceFor } from './src/models/index.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  } catch {
    return 'standalone'
  }
})()

const argv = process.argv.slice(2)
const argValue = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : ''
}

const log = (...parts) => {
  const line = parts.map(String).join(' ')
  console.log(`${new Date().toISOString()} [webbridge-standalone] ${line}`)
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.setTimeout(1500, () => {
      socket.destroy()
      resolve(false)
    })
  })
}

async function main() {
  const port = Number(argValue('--port')) || 17877
  const debug = argv.includes('--debug')

  if (await portInUse(port)) {
    log(`端口 ${port} 已被占用：请先在 DSH 会话中停止内置端点（webbridge_mcp action=stop），或确认 DSH 未运行`)
    process.exitCode = 2
    return
  }

  const settings = {
    ...resolveSettings({}),
    version: VERSION,
    debugMode: debug || undefined,
    mcp: {
      ...resolveSettings({}).mcp,
      enabled: true,
      port,
      // 独立模式不转发 DSH 工具：allowTools 必须为空
      allowTools: [],
      exposeAgent: false,
    },
  }
  if (settings.debugMode === undefined) delete settings.debugMode
  // 服务化后以 LocalSystem 运行时 os.homedir() 指向 systemprofile；
  // 用 WEBBRIDGE_HOME 显式复用用户目录下的 state/profile/adapters（含 mcp-token.key），
  // 保证与各客户端共用的 Bearer 与 Chrome 登录态一致。
  const homeOverride = String(process.env.WEBBRIDGE_HOME || '').trim()
  if (homeOverride) {
    settings.stateDir = homeOverride
    settings.browserProfileDir = join(homeOverride, 'chrome-profile')
    settings.adapterDir = join(homeOverride, 'adapters')
  }
  // 复用日常 Chrome 的 User Data（可选）：App-Bound 加密只有同一个 Chrome
  // 应用同一目录才能解开，因此共享登录态的唯一方式是直接指向用户目录。
  // 代价：日常 Chrome 必须先全部关闭（profile 独占锁）。
  const profileOverride = String(process.env.WEBBRIDGE_PROFILE_DIR || '').trim()
  if (profileOverride) {
    settings.browserProfileDir = profileOverride
  }
  ensureDirs(settings)

  const driver = new BrowserDriver(settings, log)
  const modelSources = createModelSources({ settings, driver, log, emit: () => {} })
  modelSources.gemini?.load?.().catch((error) => log(`[models] gemini cache load failed: ${error.message}`))
  const session = new ChatSession({ settings, driver, log, modelControl: modelSources.chatgpt })
  const ops = createOps({ settings, driver, session, log })
  ops.models = async (args = {}) => {
    const site = String(args.site || settings.site)
    const source = modelSourceFor(modelSources, site)
    if (!source || typeof source.list !== 'function') return { site, models: [] }
    try {
      const models = await source.list(Boolean(args.force))
      return { site, models }
    } catch (error) {
      return { site, models: [], error: error?.code || 'model-catalog-failed', message: error?.message || String(error) }
    }
  }

  // ctx 只作为「无 DSH」时的兜底：allowTools 为空，schemas() 永不被读取
  const bridge = new McpBridge({
    ctx: { tools: { schemas: () => [] } },
    settings,
    ops,
    log,
    toolScope: null,
    contextStore: null,
  })

  const status = await bridge.start()
  log(`MCP 端点已就绪: ${status.url} (version=${VERSION}, mode=standalone, port=${settings.mcp.port})`)
  log('可用工具: webbridge_ask / send / read / status / open / models / adapter / browser / debug_mode / tunnel')

  const shutdown = async (signal) => {
    log(`收到 ${signal}，停止 MCP 端点`)
    try { await bridge.stop() } catch {}
    process.exit(0)
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((error) => {
  log(`启动失败: ${error?.stack || error}`)
  process.exitCode = 1
})
