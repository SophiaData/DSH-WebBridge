import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { SITE_PRESETS, expandHome } from './config.js'
import { BridgeError } from './envelope.js'
import { domToMarkdown } from './markdown.js'
import { buildGeminiReadExpression } from './gemini-dom.js'

/** Path of the persisted adapter for one site. */
export function adapterPath(settings, site) {
  return join(expandHome(settings.adapterDir), `${site}.json`)
}

function presetAdapter(site) {
  const preset = SITE_PRESETS[site]?.adapter
  if (!preset) {
    throw new BridgeError('unknown-site', `Unknown site "${site}". Known: ${Object.keys(SITE_PRESETS).join(', ')}`)
  }
  return preset
}

/**
 * Effective adapter for a site: built-in preset overlaid with the calibrated
 * file. The file wins, because it is the only source that was ever verified
 * against a real page.
 */
export function loadAdapter(settings, site) {
  const preset = presetAdapter(site)
  const file = adapterPath(settings, site)
  if (!existsSync(file)) return { ...preset, site, source: 'preset' }
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return { ...preset, ...saved, site, source: 'file' }
  } catch (err) {
    return { ...preset, site, source: 'preset', warning: `adapter file unreadable: ${err.message}` }
  }
}

/** Persist a partial adapter patch and return the merged result. */
export function saveAdapter(settings, site, patch) {
  const current = loadAdapter(settings, site)
  const { source, site: _site, warning, ...rest } = current
  const merged = {
    ...rest,
    ...Object.fromEntries(Object.entries(patch || {}).filter(([, v]) => v !== undefined && v !== '')),
    verified: patch?.verified ?? current.verified ?? false,
    updatedAt: new Date().toISOString(),
  }
  const file = adapterPath(settings, site)
  // A fresh installation has no adapter directory yet; saving must create it.
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8')
  return merged
}

export function listAdapters(settings) {
  const dir = expandHome(settings.adapterDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -5))
    .filter((site) => Boolean(SITE_PRESETS[site]))
}

/**
 * Page-side expression that reports the assistant reply surface.
 *
 * The MutationObserver trick from browser-operator (installProbe/drainProbe)
 * does not fit here: we poll from the host instead, because the reply container
 * and the streaming flag are both DOM-readable and polling survives page
 * re-renders that would silently detach an injected observer.
 */
export function buildReadExpression(adapter) {
  if (adapter.site === 'gemini') return buildGeminiReadExpression()
  const messageSelector = JSON.stringify(adapter.messageSelector || '')
  const streamingSelector = JSON.stringify(adapter.streamingSelector || '')
  return `(() => {
    // React retains hidden replies and empty placeholders during navigation.
    // They must not become the reply baseline of a new conversation.
    const visible = (node) => node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    let messages = ${messageSelector} ? Array.from(document.querySelectorAll(${messageSelector})).filter((node) =>
      node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && (node.innerText || node.textContent || '').trim() &&
      (!${Boolean(adapter.matchReplyToUserTurn)} || node.getAttribute('data-markdown-text-style') === 'assistant-message')
    ) : [];
    if (!messages.length && ${Boolean(adapter.matchReplyToUserTurn)}) messages = Array.from(document.querySelectorAll('[data-markdown-text-style="assistant-message"]')).filter(node=>visible(node) && (node.innerText || node.textContent || '').trim());
    let last = messages.length ? messages[messages.length - 1] : null;
    const stops = ${streamingSelector} ? Array.from(document.querySelectorAll(${streamingSelector})) : [];
    if (${Boolean(adapter.matchReplyToUserTurn)}) stops.push(...document.querySelectorAll('button[data-testid="stop-button"],button[aria-label="停止"],button[aria-label="停止生成"],button[aria-label="停止流式传输"],button[aria-label="Stop"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"]'));
    const stop = stops.find(visible);
    const visibleTurn = node => visible(node) || Boolean(node.closest?.('[data-talvt-turn-state]') && visible(node.closest('[data-talvt-turn-state]')));
    const userRows = Array.from(document.querySelectorAll('[data-content-search-unit-key$=":user"]')).filter(visibleTurn);
    const lastUser = userRows[userRows.length - 1];
    const turnKey = (key) => String(key || '').replace(/:\\d+:(?:user|assistant)$/, '');
    const userBody = lastUser?.querySelector?.('[data-search-result-target]') || lastUser;
    const assistantRows = Array.from(document.querySelectorAll('[data-content-search-unit-key$=":assistant"]')).filter(visibleTurn);
    const lastAssistantRow = assistantRows[assistantRows.length - 1];
    if (!last && ${Boolean(adapter.matchReplyToUserTurn)} && lastAssistantRow) last = lastAssistantRow.querySelector?.('[data-response-body]') || lastAssistantRow;
    const text = last ? (last.innerText || last.textContent || '').trim() : '';
    const replyRow = last?.closest?.('[data-content-search-unit-key]');
    const turnRoot = lastUser?.closest?.('[data-talvt-turn-state]');
    const turnState = turnRoot?.getAttribute?.('data-talvt-turn-state') || '';
    const idleComposer = Array.from(document.querySelectorAll('button[aria-label="开始语音"],button[aria-label="Start voice mode"],button[aria-label="发送"],button[aria-label="Send"]')).some(visible);
    const activeTurn = Boolean(!idleComposer && turnState && !['complete','error','cancelled','stopped'].includes(turnState));
    const completed = turnState === 'complete' || Boolean(lastAssistantRow && turnKey(lastAssistantRow.getAttribute?.('data-content-search-unit-key')) === turnKey(lastUser?.getAttribute?.('data-content-search-unit-key')) && Array.from(lastAssistantRow.querySelectorAll?.('button') || []).some(button=>visible(button) && /复制|Copy|Good response|Bad response|赞|踩/i.test((button.getAttribute('aria-label') || '') + ' ' + (button.getAttribute('data-testid') || ''))));
    const serialize = ${domToMarkdown.toString()};
    const replyTurn = turnKey((replyRow?.getAttribute?.('data-content-search-unit-key') || '').endsWith(':assistant') ? replyRow.getAttribute('data-content-search-unit-key') : '');
    const sameTurn = messages.filter(node => turnKey(node.closest?.('[data-content-search-unit-key]')?.getAttribute?.('data-content-search-unit-key')) === replyTurn);
    const partNodes = sameTurn.length ? sameTurn : last ? [last] : [];
    const partIds = new Set();
    const pageScope = typeof window === 'undefined' ? document : window;
    const identities = pageScope.__webbridgeReplyParts ||= { nodes: new WeakMap(), next: 0 };
    const replyParts = partNodes.map((node,index) => {
      if (!identities.nodes.has(node)) identities.nodes.set(node, 'stream-part-' + identities.next++);
      const id = node.closest?.('[data-chatgpt-selection-message-id]')?.getAttribute('data-chatgpt-selection-message-id') || node.closest?.('[data-response-body]')?.getAttribute('data-response-body') || identities.nodes.get(node);
      if (partIds.has(id)) return null;
      partIds.add(id);
      return {id,text:String(node.innerText || node.textContent || '').trim(),formattedText:!stop && !activeTurn && (completed || idleComposer) ? serialize(node) : ''};
    }).filter(Boolean);
    return {
      count: messages.length,
      text: text.slice(0, 200000),
      formattedText: last && !stop && !activeTurn && (completed || idleComposer) ? serialize(last).slice(0, 200000) : '',
      replyParts,
      streaming: Boolean(stop || activeTurn),
      generationKnown: Boolean(turnState || stop || idleComposer || completed),
      completed: !stop && (idleComposer || !activeTurn && completed),
      turnState,
      webStopped: Boolean(typeof window !== 'undefined' && window.__webbridgeGenerationWatch?.active && window.__webbridgeGenerationWatch?.stopped) || ['cancelled','stopped'].includes(turnState),
      requestActive: Boolean(typeof window !== 'undefined' && window.__webbridgeGenerationWatch?.active),
      url: location.href,
      userTurnKey: turnKey(lastUser?.getAttribute?.('data-content-search-unit-key')),
      userText: String(userBody?.innerText || userBody?.textContent || '').trim(),
      replyTurnKey: replyTurn,
      replyId: last?.closest?.('[data-chatgpt-selection-message-id]')?.getAttribute('data-chatgpt-selection-message-id') || '',
      title: document.title
    };
  })()`
}

/** State of the site's reasoning toggle, read from the DOM. */
export function buildReasoningStateExpression(adapter) {
  const selector = JSON.stringify(adapter.reasoning?.selector || '')
  const text = JSON.stringify(adapter.reasoning?.text || '')
  const selectedClass = JSON.stringify(adapter.reasoning?.selectedClass || '')
  const labels = JSON.stringify(adapter.reasoning?.labels || [])
  const selectedAttribute = JSON.stringify(adapter.reasoning?.selectedAttribute || '')
  return `(() => {
    if (!${selector}) return { supported: false, found: false, selected: false };
    const nodes = Array.from(document.querySelectorAll(${selector}));
    const labels = ${labels};
    const match = nodes.filter(el=>el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).find((el) =>
      labels.length ? labels.some(label=>(el.innerText || '').trim() === label) : !${text} || (el.innerText || '').includes(${text}));
    if (!match) return { supported: true, found: false, selected: false, total: nodes.length };
    return {
      supported: true,
      found: true,
      selected: ${selectedAttribute} ? match.getAttribute(${selectedAttribute}) === 'true' : ${selectedClass} ? String(match.className || '').includes(${selectedClass}) : false,
      label: (match.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30)
    };
  })()`
}

/** Playwright selector for clicking the configured reasoning toggle. */
export function reasoningClickSelector(adapter) {
  if (adapter.reasoning?.clickSelector) return adapter.reasoning.clickSelector
  const text = adapter.reasoning?.text
  if (!text) return adapter.reasoning?.selector || ''
  return `text=${text}`
}

/** Page-side expression used by calibration to propose selectors. */
export function buildProbeExpression(adapter) {  const inputSelector = JSON.stringify(adapter.inputSelector || '')
  return `(() => {
    const input = ${inputSelector} ? document.querySelector(${inputSelector}) : null;
    const editable = document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]');
    return {
      inputFound: Boolean(input),
      inputTag: input ? input.tagName : '',
      editableCount: editable.length,
      editableTags: Array.from(editable).slice(0, 5).map((el) => el.tagName + (el.id ? '#' + el.id : '')),
      assistantNodes: ${JSON.stringify(adapter.messageSelector || '')} ? document.querySelectorAll(${JSON.stringify(adapter.messageSelector || '')}).length : 0
    };
  })()`
}
