import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { defaultFingerprint } from './browser-fingerprint.js'

/** Expand a leading ~ and return an absolute path. */
export function expandHome(value) {
  if (typeof value !== 'string' || !value) return value
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

export const DEFAULTS = {
  enabled: true,

  /** Native WebBridge-owned Chrome runtime; BrowserOperator remains untouched. */
  browserProfileDir: '~/.dsh/webbridge/chrome-profile',
  browserExecutablePath: '',
  /** Debug mode shows browser tasks on demand; normal mode is headless. */
  debugMode: false,
  chromeVersion: '157.0.8103.52',
  fingerprint: defaultFingerprint(),
  site: 'chatgpt',

  /** Reply completion detection. Zero waits until the reply finishes or is stopped. */
  replyTimeoutMs: 0,
  pollIntervalMs: 250,
  stableSamples: 3,
  /** How long a single browser command may take before it is killed. */
  commandTimeoutMs: 60000,

  /** Where per-site selectors are persisted (calibration survives restarts). */
  adapterDir: '~/.dsh/webbridge/adapters',
  stateDir: '~/.dsh/webbridge',

  /** Mode A+ defaults. `defaultTools` empty means webbridge_agent requires an explicit list. */
  agent: {
    defaultTools: [],
    maxTurns: 6,
  },

  /** Web chats registered as DSH model providers. */
  providers: {
    enabled: true,
    contextWindow: 32000,
  },

  /** Visible sites: ChatGPT uses native MCP; Gemini uses the bounded text
   *  tool protocol and must pass login plus live-page acceptance. Other site
   *  presets remain opt-in through this array. */
  sites: {
    visible: ['chatgpt', 'gemini'],
  },

  tunnel: {
    runtimePath: '',
  },

  /** MCP exposure (M4, currently disabled). */
  mcp: {
    enabled: false,
    port: 17877,
    token: '',
    allowTools: [],
    exposeAgent: false,
    requestsPerMinute: 60,
    allowedHosts: [],
  },
}

export const SITE_PRESETS = {
  chatgpt: {
    label: 'ChatGPT',
    url: 'https://chatgpt.com/',
    adapter: {
      inputSelector: 'div.ProseMirror',
      sendSelector: 'button[aria-label="Send"], button[aria-label="发送"], button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="发送提示词"], form button[type="submit"]',
      messageSelector: '[class*="MarkdownRoot"]',
      streamingSelector: '',
      stripPrompt: false,
      requireCountGrowth: true,
      matchReplyToUserTurn: true,
      pluginName: 'WebBridge DSH',
      reasoning: {
        selector: 'button[aria-pressed]',
        labels: ['思考', 'Think'],
        clickSelector: 'button[aria-pressed]:has-text("思考"), button[aria-pressed]:has-text("Think")',
        selectedAttribute: 'aria-pressed',
      },
      newChatSelector: '',
      verified: true,
      notes: 'Composer is div.ProseMirror; assistant replies render as [class*="MarkdownRoot"]. The 2026 UI has no data-message-author-role / article / stop-button nodes, so completion relies on text stability.',
    },
    newChatShortcut: process.platform === 'darwin' ? 'Meta+Shift+KeyO' : 'Control+Shift+KeyO',
    readTitle: true,
  },
  bigmodel: {
    label: '智谱体验中心 (GLM-5.3)',
    url: 'https://bigmodel.cn/trialcenter/modeltrial/text?modelCode=glm-5.3',
    adapter: {
      inputSelector: "textarea.el-textarea__inner, textarea[placeholder*='输入'], div[contenteditable='true'], textarea",
      sendSelector: 'div.submit-btn, .submit-btn',
      messageSelector: '.markdown-body, .chat-content, .message-content, .answer-content',
      streamingSelector: ".icon-stop, .icon-pause, button[aria-label*='停止']",
      stripPrompt: false,
      requireCountGrowth: true,
      matchReplyToUserTurn: false,
      verified: false,
      notes: 'Live-verified on the real trial page: composer is textarea.el-textarea__inner and the send control is div.submit-btn (iconfont icon-send1 inside). WebAgent 1.3.2 assumed .icon-send2, which does not exist there.',
    },
    newChatSelector: '',
    readTitle: false,
  },
  chatglm: {
    label: '智谱清言',
    url: 'https://chatglm.cn/',
    adapter: {
      inputSelector: 'textarea.scroll-display-none, textarea',
      sendSelector: "div.enter-icon-container, div[class*='enter-icon'], img.enter_icon",
      messageSelector: '.answer-content, .markdown-body, .chat-content, .message-content',
      streamingSelector: ".icon-stop, .icon-pause, button[aria-label*='停止']",
      stripPrompt: false,
      requireCountGrowth: true,
      matchReplyToUserTurn: false,
      verified: false,
      notes: 'Live-verified: composer is textarea.scroll-display-none; send is div.enter-icon-container (an "empty" state class toggles with the draft); replies render in .answer-content and include a visible thinking section.',
    },
    newChatSelector: '',
    readTitle: false,
  },
  zai: {
    label: 'Z.ai',
    url: 'https://zchat.z.ai/',
    adapter: {
      inputSelector: '#chat-input, textarea[placeholder*="输入"], div[contenteditable="true"], textarea',
      sendSelector: '#send-message-button, button[aria-label*="Send" i], button[aria-label*="发送"]',
      messageSelector: '#response-content-container, [class*="assistant"], div[class*="markdown"], [class*="message-content"]',
      streamingSelector: '#stop-response-button, button[aria-label*="Stop" i], button[aria-label*="停止"]',
      stripPrompt: false,
      requireCountGrowth: true,
      matchReplyToUserTurn: false,
      verified: false,
      notes: 'Live-verified selectors (#chat-input / #send-message-button). The preset URL is the canonical chat domain zchat.z.ai: chat.z.ai is a marketing landing that redirects here and its transient Log-in button trips the legacy auth gate.',
    },
    newChatSelector: '',
    readTitle: false,
  },
  deepseek: {
    label: 'DeepSeek',
    url: 'https://chat.deepseek.com/',
    adapter: {
      inputSelector: 'textarea[placeholder*="DeepSeek"], textarea',
      sendSelector: 'div.ds-button--primary.ds-button--circle, div[role="button"].ds-button--primary',
      messageSelector: '.ds-assistant-message-main-content, [class*="ds-assistant-message"], .ds-markdown',
      streamingSelector: 'div[role="button"][aria-label*="停止"], button[data-testid="stop-button"]',
      stripPrompt: false,
      requireCountGrowth: true,
      matchReplyToUserTurn: false,
      // 思考/不思考 exposed as two DSH models, like ChatGPT's dual entries.
      dualReasoning: true,
      reasoning: {
        selector: 'div.ds-toggle-button',
        labels: ['DeepThink', '深度思考'],
        clickSelector: 'div.ds-toggle-button:has-text("DeepThink"), div.ds-toggle-button:has-text("深度思考")',
        selectedAttribute: 'aria-pressed',
      },
      verified: false,
      notes: 'Live-verified: composer is a plain textarea (placeholder "Message DeepSeek"; the old #chat-input is gone), send is the circle primary ds-button, DeepThink toggle is div.ds-toggle-button with aria-pressed. The Search (联网搜索) toggle sits next to it with the same shape; wire adapter.search the same way if a search-on variant is ever wanted.',
    },
    newChatSelector: '',
    readTitle: false,
  },
  kimi: {
    label: 'Kimi',
    url: 'https://www.kimi.com/',
    adapter: {
      inputSelector: 'div.chat-input-editor, div[contenteditable="true"][data-slate-editor="true"], div[contenteditable="true"]',
      sendSelector: 'div.send-button-container, div[data-testid="send-button"], button[aria-label*="Send"]',
      messageSelector: '.segment-content-box, .markdown-content, .chat-content, div[class*="segment-content"]',
      streamingSelector: '.stop-btn, button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="停止"]',
      stripPrompt: false,
      requireCountGrowth: true,
      matchReplyToUserTurn: false,
      verified: false,
      notes: 'Live-verified: composer is the contenteditable div.chat-input-editor, send is div.send-button-container (a disabled class toggles with the draft), replies render in .segment-content-box and include a visible thinking section ("Thinking complete" prefix).',
    },
    newChatSelector: '',
    readTitle: false,
  },
  doubao: {
    label: '豆包',
    url: 'https://www.doubao.com/chat/',
    adapter: {
      inputSelector: 'div[contenteditable="true"], textarea[data-testid="chat_input_textarea"], textarea[placeholder*="发送消息"], textarea',
      sendSelector: 'button[data-testid="chat_input_send_button"], div[data-testid="chat_input_send_button"], button.semi-button--primary, button[aria-label*="发送"]',
      messageSelector: "[data-testid='message-content'], .doubao-markdown, [data-testid='receive_message'], div[class*='message-content']",
      streamingSelector: 'button[data-testid="chat_input_stop_button"], button[aria-label*="停止生成"], .semi-button--loading',
      stripPrompt: false,
      requireCountGrowth: true,
      matchReplyToUserTurn: false,
      verified: false,
      notes: 'Selectors ported from WebAgent 1.3.2 doubao adapter (Semi Design UI).',
    },
    newChatSelector: '',
    readTitle: false,
  },
  duckai: {
    label: 'Duck.ai',
    url: 'https://duck.ai/',
    adapter: {
      inputSelector: 'textarea[name="user-prompt"], textarea[name="q"], textarea[placeholder*="Ask"], textarea[data-testid*="input"], form textarea',
      sendSelector: 'button[type="submit"], button[aria-label*="Send"], button[aria-label*="Ask"]',
      messageSelector: "[data-testid*='chat-message'], [data-testid*='response'], .markdown, div[class*='message-content']",
      streamingSelector: 'button[aria-label*="Stop generating"], button[aria-label="Stop"]',
      stripPrompt: false,
      requireCountGrowth: true,
      matchReplyToUserTurn: false,
      verified: false,
      notes: 'Duck.ai works without an account; the login probe usually reports ready immediately. Needs network access to duck.ai.',
    },
    newChatSelector: '',
    readTitle: false,
  },
  qwen: {
    label: '通义千问',
    url: 'https://chat.qwen.ai/',
    adapter: {
      inputSelector: 'textarea#chat-input, textarea.chat-input, div[contenteditable="true"], textarea[placeholder*="输入"]',
      sendSelector: '#send-message-button, button.send-btn, button[aria-label*="发送"], button[aria-label*="Send"]',
      messageSelector: '.qwen-chat-message, .chat-message-item, div[class*="message-content"], div[class*="markdown"]',
      streamingSelector: "button[aria-label*='停止'], button[aria-label*='Stop'], .ant-btn-loading",
      stripPrompt: false,
      requireCountGrowth: true,
      matchReplyToUserTurn: false,
      verified: false,
      notes: "WebAgent's loose button:has(svg rect) streaming fallback is dropped on purpose: it sticks true on unrelated icons.",
    },
    newChatSelector: '',
    readTitle: false,
  },
  dola: {
    label: 'Dola',
    url: 'https://www.dola.com/',
    adapter: {
      inputSelector: "textarea[placeholder*='发送'], textarea[placeholder*='Ask'], textarea[placeholder*='Type'], div[contenteditable='true']",
      sendSelector: "button[type='submit'], button[aria-label*='Send'], button[aria-label*='发送'], button.send-btn",
      messageSelector: "[data-testid*='message'], .markdown, div[class*='chat-item']",
      streamingSelector: "button[aria-label*='Stop'], button[aria-label*='停止'], button.stop-btn",
      stripPrompt: false,
      requireCountGrowth: true,
      matchReplyToUserTurn: false,
      verified: false,
      notes: 'Selectors ported from WebAgent 1.3.2 dola adapter; needs network access to dola.com.',
    },
    newChatSelector: '',
    readTitle: false,
  },
  gemini: {
    label: 'Gemini',
    url: 'https://gemini.google.com/app',
    adapter: {
      inputSelector: 'rich-textarea .ql-editor[contenteditable="true"], rich-textarea [role="textbox"][contenteditable="true"], .input-area [role="textbox"][contenteditable="true"]',
      sendSelector: 'button.send-button, button[aria-label="发送"], button[aria-label="Send message"], button[aria-label="Send"]',
      messageSelector: 'model-response',
      streamingSelector: 'button.stop-button, button[aria-label="Stop response"], button[aria-label="停止回答"], button[aria-label="停止"]',
      stripPrompt: false,
      requireCountGrowth: false,
      matchReplyToUserTurn: false,
      verified: false,
      notes: 'Selectors ported from WebAgent gemini-adapter.js; needs network access to Google.',
    },
    newChatSelector: '',
    readTitle: false,
  },
  aistudio: {
    label: 'AI Studio',
    url: 'https://aistudio.google.com/prompts/new_chat',
    adapter: {
      inputSelector: 'ms-autosize-textarea textarea, .chat-prompt-textarea textarea, textarea.prompt-textarea, textarea[aria-label*="Prompt"]',
      sendSelector: 'button.run-button:not([disabled]), button[aria-label*="Run"]:not([disabled]), button:has(mat-icon[fonticon="play_arrow"])',
      messageSelector: "ms-chat-turn:not(.user-turn), ms-chat-turn.model-turn, div.model-response, div.chat-turn-content, ms-markdown",
      streamingSelector: 'button.stop-button, button[aria-label*="Cancel"], button:has(mat-icon[fonticon="stop"]), mat-progress-bar',
      stripPrompt: false,
      requireCountGrowth: true,
      matchReplyToUserTurn: false,
      verified: false,
      notes: 'Google AI Studio prompt playground; new chat opens prompts/new_chat. Needs network access to Google.',
    },
    newChatSelector: '',
    readTitle: false,
  },
}

export function resolveSettings(config = {}) {
  const merged = {
    ...DEFAULTS,
    ...config,
    fingerprint: { ...DEFAULTS.fingerprint, ...(config.fingerprint || {}) },
    agent: { ...DEFAULTS.agent, ...(config.agent || {}) },
    providers: { ...DEFAULTS.providers, ...(config.providers || {}) },
    sites: { ...DEFAULTS.sites, ...(config.sites || {}) },
    mcp: { ...DEFAULTS.mcp, ...(config.mcp || {}) },
    tunnel: { ...DEFAULTS.tunnel, ...(config.tunnel || {}) },
  }
  // Older installations may still persist `site: deepseek`. The site is no
  // longer supported, so migrate stale configuration to the only available
  // preset instead of leaving the plugin unable to start.
  if (!SITE_PRESETS[merged.site]) merged.site = DEFAULTS.site
  merged.browserProfileDir = expandHome(merged.browserProfileDir)
  merged.browserExecutablePath = expandHome(merged.browserExecutablePath)
  merged.adapterDir = expandHome(merged.adapterDir)
  merged.stateDir = expandHome(merged.stateDir)
  return merged
}

/** Sites exposed in the DSH model menu and the settings page. Unknown keys
 *  are dropped and an empty list falls back to ChatGPT; the full preset table
 *  stays available to tools and calibration either way. */
export function visibleSites(settings) {
  const requested = Array.isArray(settings?.sites?.visible) ? settings.sites.visible : []
  const known = requested.filter(site => Boolean(SITE_PRESETS[site]))
  return known.length ? known : ['chatgpt']
}

export function ensureDirs(settings) {
  for (const dir of [settings.adapterDir, settings.stateDir, settings.browserProfileDir]) {
    try { if (dir) mkdirSync(dir, { recursive: true }) } catch {}
  }
}
