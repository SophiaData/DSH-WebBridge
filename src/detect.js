import { buildReadExpression } from './adapters.js'
import { BridgeError } from './envelope.js'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { visibleTextKey } from './stream-text.js'

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const aborted = () => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', aborted)
    reject(new BridgeError('aborted', 'Reply wait was aborted'))
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', aborted)
    resolve()
  }, ms)
  if (signal?.aborted) return aborted()
  signal?.addEventListener('abort', aborted, { once: true })
})

/** Read the current reply surface. Returns {count, text, streaming, url}. */
export async function readReplyState(driver, adapter, signal) {
  const parsed = await driver.eval(buildReadExpression(adapter), { signal })
  const value = parsed?.result
  if (!value || typeof value !== 'object') {
    throw new BridgeError('read-failed', 'Could not read the reply container; the adapter selectors may be wrong')
  }
  return {
    count: Number(value.count) || 0,
    text: String(value.text || ''),
    formattedText: String(value.formattedText || ''),
    replyParts: Array.isArray(value.replyParts) ? value.replyParts.filter(part => part && typeof part.id === 'string' && typeof part.text === 'string') : [],
    streaming: Boolean(value.streaming),
    generationKnown: Boolean(value.generationKnown),
    completed: Boolean(value.completed),
    webStopped: Boolean(value.webStopped),
    // The site's first send can replace the document and its window globals.
    // The host keeps ownership until this exact request's finally block runs.
    requestActive: Boolean(value.requestActive || driver.generations?.has(driver.currentKey?.())),
    url: String(value.url || ''),
    userTurnKey: String(value.userTurnKey || ''),
    userText: String(value.userText || ''),
    replyTurnKey: String(value.replyTurnKey || ''),
    replyId: String(value.replyId || ''),
  }
}

/**
 * Wait until the assistant finishes a reply.
 *
 * Completion is judged by TEXT CHANGE plus stability, not by counting messages.
 * Web chats can virtualize older rows, so the assistant-node count may stay at 1
 * or even shrink across a new reply. A count-only detector would hang forever.
 *
 * Votes:
 *   1. reached — the last assistant text changed from the pre-send baseline, or
 *      a new assistant node appeared
 *   2. quiet — no streaming indicator (when the adapter declares one)
 *   3. stable — the text stopped changing for `stableSamples` consecutive polls
 *
 * Zero (the default) waits until completion or cancellation. An explicitly
 * configured positive budget may return captured text with truncated:true.
 */
export async function waitForReply({ driver, adapter, baseline, settings, signal, log, expectedText, expectedTurnKey, onProgress, onReconnect, activity }) {
  const started = Date.now()
  const timeoutMs = Number(settings.replyTimeoutMs) || 0
  const deadline = timeoutMs > 0 ? started + timeoutMs : Infinity
  const pollMs = Math.max(1, Number(settings.pollIntervalMs) || 250)
  const stableSamples = Math.max(1, Number(settings.stableSamples) || 3)

  const baselineText = baseline?.text ?? ''
  const baselineCount = baseline?.count ?? 0

  let lastText = ''
  let lastCount = baselineCount
  let stable = 0
  let reached = false
  let sawStreaming = false
  let lastError = null
  let acceptedState = null
  let targetTurnKey = expectedTurnKey || ''
  let publishedText = ''
  const replyParts = new Map()
  const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim()
  const expected = normalize(expectedText)
  const pluginName = normalize(adapter.pluginName)
  const withoutPlugin = text => text.split(pluginName).join('').replace(/\s+/g, '')
  const assertReplyPage = driver.replyPageGuard?.()
  let lastWaitState = ''
  let lastReadError = ''
  let lostSince = null
  let reconnectAttempted = false
  let reconnectPending = false
  let reconnectUntil = 0
  const failLostReply = () => {
    activity?.emit('reply.reconnect-failed', '仍未找回本轮回复，结束等待；已完成的工具操作不会重做', { targetTurnKey })
    throw new BridgeError('reply-turn-lost', '网页已切回旧轮次，无法找回本轮回复，已结束等待。已完成的工具操作不会重复执行，请检查已生成的文件后重试。')
  }

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new BridgeError('aborted', 'Reply wait was aborted')

    let state
    try {
      assertReplyPage?.()
      state = await readReplyState(driver, adapter, signal)
      if (lastReadError) activity?.emit('reply.read-recovered', '已重新读取到回复区元素')
      lastReadError = ''
      lastError = null
    } catch (err) {
      lastError = err
      const code = err.code || err.name
      if (lastReadError !== code) activity?.emit('reply.read-failed', '读取回复区元素失败', { code })
      lastReadError = code
      if (['aborted', 'browser-closed', 'manual-auth-required', 'driver-missing', 'account-restricted'].includes(err?.code) || String(err?.code || '').startsWith('auth-required')) throw err
      await sleep(pollMs, signal)
      continue
    }

    let text = state.text || ''
    if (state.webStopped) throw new BridgeError('web-generation-stopped', '网页生成已中止。')
    const grown = state.count > baselineCount
    const changed = text !== '' && text !== baselineText
    // Sites that append a node per reply (ChatGPT) must show a new node before a
    // "stable text" is accepted; otherwise the previous answer is returned again
    // and every session appears to repeat itself.
    // Long answers can virtualize their user row. Once a turn is bound, its
    // assistant row remains sufficient to identify subsequent text snapshots.
    const actualText = normalize(state.userText)
    // ChatGPT can insert its app mention inside the submitted text before the
    // new turn key is available. Compare that prompt without the known mention.
    const promptMatches = !expected || actualText.includes(expected) || (expected.length >= 80 && actualText.includes(expected.slice(0, 80))) ||
      Boolean(pluginName && actualText.includes(pluginName) && withoutPlugin(actualText).includes(withoutPlugin(expected)))
    // ChatGPT may replace its optimistic client turn key after persisting the
    // message. Rebind only when the visible new user prompt still identifies
    // this request; never pin forever to a transient post-click key.
    if (state.userTurnKey && state.userTurnKey !== baseline?.userTurnKey && promptMatches && !state.userTurnKey.startsWith('fallback-')) targetTurnKey = state.userTurnKey
    const newAssistant = Boolean(state.replyTurnKey && !state.replyTurnKey.startsWith('fallback-') &&
      state.replyTurnKey !== baseline?.replyTurnKey && state.replyTurnKey !== baseline?.userTurnKey &&
      (state.replyId ? state.replyId !== baseline?.replyId : changed || grown))
    if (state.requestActive && newAssistant && (!state.userTurnKey || state.userTurnKey.startsWith('fallback-'))) targetTurnKey = state.replyTurnKey
    const currentUserKey = targetTurnKey && state.replyTurnKey === targetTurnKey ? targetTurnKey : state.userTurnKey
    const newUserTurn = Boolean(currentUserKey && currentUserKey !== baseline?.userTurnKey)
    const targetMatches = targetTurnKey ? currentUserKey === targetTurnKey : promptMatches
    // Gemini's user-query identity is stronger than an assistant node count:
    // don't accept a stale response while a new prompt is being submitted.
    const geminiNewQuery = adapter.site === 'gemini' && expected && state.userTurnKey &&
      state.userTurnKey !== baseline?.userTurnKey && normalize(state.userText) === expected
    const reachedNow = adapter.site === 'gemini'
      ? Boolean(geminiNewQuery && (grown || changed))
      : adapter.matchReplyToUserTurn
        ? Boolean(newUserTurn && state.replyTurnKey === currentUserKey && targetMatches)
        : adapter.requireCountGrowth ? grown : grown || changed
    if (reconnectPending) {
      if (reachedNow || state.streaming && state.userTurnKey === targetTurnKey && promptMatches) {
        reconnectPending = false
        activity?.emit('reply.reconnected', '已找回本轮回复元素，继续监听和回传', { targetTurnKey })
      } else if (Date.now() >= reconnectUntil) failLostReply()
    }
    const lostTurn = adapter.matchReplyToUserTurn && targetTurnKey && !reachedNow &&
      !state.streaming && state.completed && state.userTurnKey &&
      state.userTurnKey !== targetTurnKey && !promptMatches
    if (lostTurn) {
      lostSince ??= Date.now()
      if (Date.now() - lostSince >= 5000) {
        if (reconnectAttempted || !onReconnect) failLostReply()
        reconnectAttempted = true
        reconnectPending = true
        activity?.emit('reply.reconnecting', '网页持续显示旧轮次，正在回到对话底部并重新桥接本轮回复', { targetTurnKey })
        try { await onReconnect({ turnKey: targetTurnKey }) }
        catch (error) {
          activity?.emit('reply.reconnect-failed', '重新桥接本轮回复失败', { code: error.code || error.name })
          throw error
        }
        if (signal?.aborted) throw new BridgeError('aborted', '回复恢复已取消。')
        lostSince = Date.now()
        reconnectUntil = Date.now() + 5000
        stable = 0
        continue
      }
    } else lostSince = null
    const waitState = !reachedNow ? 'waiting-turn' : state.streaming ? 'streaming' : text ? 'settling' : 'waiting-text'
    if (waitState !== lastWaitState) {
      lastWaitState = waitState
      const messages = {
        'waiting-turn': '仍在监听本轮回复元素，当前可见回复尚未匹配本轮消息',
        streaming: '监听到本轮回复元素，网页正在生成回复',
        settling: '监听到本轮回复内容，正在确认网页生成已完成且内容稳定',
        'waiting-text': '已匹配本轮回复元素，正在等待正文',
      }
      activity?.emit(`reply.${waitState}`, messages[waitState], {
        selector: adapter.messageSelector, chars: text.length, count: state.count,
        streaming: state.streaming, completed: state.completed, requestActive: state.requestActive,
        promptMatches, targetMatches, reachedNow, targetTurnKey,
        userTurnKey: state.userTurnKey, replyTurnKey: state.replyTurnKey, replyId: state.replyId,
      })
    }
    if (settings.stateDir) {
      try { writeFileSync(join(settings.stateDir, 'reply-state.json'), JSON.stringify({ at: Date.now(), streaming: state.streaming, completed: state.completed, requestActive: state.requestActive, replyId: state.replyId, chars: text.length, count: state.count, userKey: state.userTurnKey, replyKey: state.replyTurnKey, targetTurnKey, expectedTurnKey, baselineUserKey: baseline?.userTurnKey || '', promptMatches, targetMatches, reachedNow, newUserTurn, currentUserKey })) } catch {}
    }
    if (state.streaming) sawStreaming = true
    if (reachedNow && state.replyParts.length) {
      for (const part of state.replyParts) {
        if (!part.text) continue
        let key = part.id
        for (const [oldKey, prior] of replyParts) {
          const provisional = /^(?:stream-)?part-\d+$/.test(prior.id) || /^(?:stream-)?part-\d+$/.test(part.id)
          if (prior.id === part.id || provisional && visibleTextKey(part.text).key.startsWith(visibleTextKey(prior.text).key)) {
            key = oldKey
            break
          }
        }
        replyParts.set(key, { ...replyParts.get(key), ...part })
      }
      text = [...replyParts.values()].map(part => part.text).join('\n\n')
      if (!state.streaming) state.formattedText = [...replyParts.values()].map(part => part.formattedText || part.text).join('\n\n')
    }
    if (reachedNow && text && text !== publishedText) { publishedText = text; onProgress?.({ text, streaming: state.streaming, userTurnKey: currentUserKey, replyId: state.replyId }) }
    if (adapter.matchReplyToUserTurn && !reachedNow) {
      stable = 0
      await sleep(pollMs, signal)
      continue
    }
    if (!reached && reachedNow) reached = true
    if (state.count > lastCount) lastCount = state.count

    if (state.streaming) {
      sawStreaming = true
      stable = 0
    } else if (reached && text && text === lastText && (!state.replyId || state.replyId === acceptedState?.replyId)) {
      stable += 1
    } else {
      stable = 0
    }
    if (text) lastText = text
    if (reachedNow) acceptedState = { ...state, userTurnKey: currentUserKey }

    const finished = !adapter.matchReplyToUserTurn || !state.generationKnown || state.completed || (sawStreaming && !state.streaming)
    if (reached && stable >= stableSamples && lastText && finished) {
      activity?.emit('reply.completed', '已确认本轮回复生成完成', { chars: lastText.length, stableSamples: stable, sawStreaming })
      return {
        text: acceptedState?.formattedText || lastText,
        count: lastCount,
        elapsedMs: Date.now() - started,
        streaming: false,
        truncated: false,
        sawStreaming,
        userTurnKey: acceptedState?.userTurnKey || '',
        replyTurnKey: acceptedState?.replyTurnKey || '',
        replyId: acceptedState?.replyId || '',
      }
    }
    await sleep(pollMs, signal)
  }

  if (lastError && !lastText) throw lastError
  if (!reached || !lastText) {
    activity?.emit('reply.timeout', '等待本轮回复超时，未取得可用回复', { timeoutMs, count: lastCount, baselineCount })
    throw new BridgeError(
      'reply-timeout',
      `No new assistant reply appeared within ${settings.replyTimeoutMs}ms. Check the adapter selectors and whether the message was actually sent.`,
      { count: lastCount, baselineCount },
    )
  }
  log?.(`[webbridge] reply timed out with ${lastText.length} chars captured`)
  activity?.emit('reply.partial', '等待超时，返回已取得的部分回复', { chars: lastText.length, timeoutMs })
  return {
    text: lastText,
    count: lastCount,
    elapsedMs: Date.now() - started,
    streaming: sawStreaming,
    truncated: true,
    sawStreaming,
    userTurnKey: acceptedState?.userTurnKey || '',
    replyTurnKey: acceptedState?.replyTurnKey || '',
    replyId: acceptedState?.replyId || '',
  }
}
