import { domToMarkdown } from './markdown.js'

/**
 * Read Gemini's last visible response and its corresponding latest user query.
 * Unlike ChatGPT, Gemini uses <user-query> and <model-response>, not turn-key rows.
 * Never count nested message-content and model-response as two answers.
 */
export function buildGeminiReadExpression() {
  return `(() => {
    const visible = el => Boolean(el?.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }));
    const queries = Array.from(document.querySelectorAll('user-query')).filter(visible);
    const user = queries.at(-1);
    const lines = Array.from(user?.querySelectorAll?.('.query-text-line') || []);
    const userText = (lines.length ? lines.map(line => line.textContent || '').join('\\n')
      : user?.textContent || '').trim();
    const hash = value => {
      let num = 2166136261;
      for (let i = 0; i < value.length; i++) num = Math.imul(num ^ value.charCodeAt(i), 16777619);
      return (num >>> 0).toString(36);
    };
    const responses = Array.from(document.querySelectorAll('model-response')).filter(visible);
    const lastResponse = responses.at(-1);
    // A virtualized Gemini conversation can replace its latest DOM node while
    // keeping the same visible response count and exact same answer text.
    const scope = typeof window === 'undefined' ? document : window;
    const identities = scope.__webbridgeGeminiReplyIds ||= { nodes: new WeakMap(), next: 0 };
    if (lastResponse && !identities.nodes.has(lastResponse)) identities.nodes.set(lastResponse, 'gemini-model-' + ++identities.next);
    const content = lastResponse?.querySelector?.('message-content, .markdown-main-panel, .markdown') || lastResponse;
    const clean = content?.cloneNode?.(true);
    clean?.querySelectorAll?.('[class*="thought"], [class*="reasoning"], model-thoughts, details').forEach(node => node.remove());
    const serialize = ${domToMarkdown.toString()};
    const text = clean ? serialize(clean).slice(0, 200000) : '';
    const stop = Array.from(document.querySelectorAll('button.stop-button, button[aria-label="Stop response"], button[aria-label="Stop generating"], button[aria-label="停止回答"], button[aria-label="停止生成"], button[aria-label="停止响应"], button[aria-label="停止"]')).find(visible);
    return {
      count: responses.length,
      text,
      formattedText: !stop ? text : '',
      replyParts: [],
      streaming: Boolean(stop),
      generationKnown: Boolean(lastResponse || stop),
      completed: Boolean(lastResponse && !stop),
      webStopped: Boolean(typeof window !== 'undefined' && window.__webbridgeGenerationWatch?.stopped),
      requestActive: Boolean(typeof window !== 'undefined' && window.__webbridgeGenerationWatch?.active),
      url: location.href,
      userTurnKey: user ? 'gemini-q-' + queries.length + '-' + hash(userText) : '',
      userText,
      replyTurnKey: lastResponse ? 'gemini-r-' + responses.length : '',
      replyId: lastResponse ? (lastResponse.getAttribute?.('data-id') || identities.nodes.get(lastResponse) || '') : ''
    };
  })()`
}
