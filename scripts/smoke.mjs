/**
 * Offline smoke test: exercises the parts that do not need a browser or DSH.
 * Run with: node scripts/smoke.mjs
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import { resolveSettings, SITE_PRESETS } from '../src/config.js'
import { ok, fail, BridgeError, toFailure, digest, auditRecord } from '../src/envelope.js'
import { loadAdapter, saveAdapter, listAdapters, buildReadExpression, buildReasoningStateExpression, reasoningClickSelector } from '../src/adapters.js'
import { BrowserDriver } from '../src/driver.js'

const tmp = mkdtempSync(join(tmpdir(), 'webbridge-'))
let passed = 0
const test = (name, fn) => {
  fn()
  passed++
  console.log(`ok - ${name}`)
}

try {
  const settings = resolveSettings({ adapterDir: tmp, stateDir: tmp, site: 'chatgpt' })

  test('settings merge keeps mcp defaults', () => {
    assert.equal(settings.mcp.enabled, false)
    assert.equal(settings.replyTimeoutMs, 0)
    assert.ok(settings.browserProfileDir.endsWith('chrome-profile'))
  })

  test('preset adapter is loaded when no file exists', () => {
    const adapter = loadAdapter(settings, 'chatgpt')
    assert.equal(adapter.source, 'preset')
    assert.equal(typeof adapter.verified, 'boolean')
    assert.equal(adapter.inputSelector, SITE_PRESETS.chatgpt.adapter.inputSelector)
  })

  test('saved adapter overrides the preset and is listed', () => {
    const saved = saveAdapter(settings, 'chatgpt', {
      inputSelector: '#custom-input',
      messageSelector: '.custom-reply',
      verified: true,
    })
    assert.equal(saved.inputSelector, '#custom-input')
    assert.equal(saved.verified, true)
    const reloaded = loadAdapter(settings, 'chatgpt')
    assert.equal(reloaded.source, 'file')
    assert.equal(reloaded.messageSelector, '.custom-reply')
    assert.deepEqual(listAdapters(settings), ['chatgpt'])
    assert.ok(existsSync(join(tmp, 'chatgpt.json')))
  })

  test('read expression quotes selectors safely', () => {
    const expr = buildReadExpression(loadAdapter(settings, 'chatgpt'))
    assert.ok(expr.includes('".custom-reply"'))
    assert.ok(expr.includes('document.querySelectorAll'))
    // The generated expression must at least parse as JavaScript.
    new Function(`return ${expr}`)
  })

  test('known site presets include Gemini; unknown sites are rejected safely', () => {
    assert.ok(SITE_PRESETS.chatgpt)
    assert.ok(SITE_PRESETS.gemini)
    assert.equal(resolveSettings().site, 'chatgpt')
    assert.equal(resolveSettings({ site: 'gemini' }).site, 'gemini')
    assert.equal(resolveSettings({ site: 'not-a-site' }).site, 'chatgpt')
    assert.throws(() => loadAdapter(settings, 'not-a-site'), (error) => error.code === 'unknown-site')
    const adapter = loadAdapter(resolveSettings({ adapterDir: tmp + '/none' }), 'chatgpt')
    const expr = buildReasoningStateExpression(adapter)
    assert.ok(expr.includes('Think'))
    new Function(`return ${expr}`)
    assert.match(reasoningClickSelector(adapter), /Think/)
  })

  test('success envelope is JSON with ok:true', () => {
    const body = JSON.parse(ok({ tool: 'x', value: 1 }))
    assert.equal(body.ok, true)
    assert.equal(body.value, 1)
  })

  test('failure envelope carries a stable code and sanitizes paths', () => {
    const body = JSON.parse(fail('driver-timeout', 'failed at C:\\Users\\me\\secret\\file.txt'))
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'driver-timeout')
    assert.ok(!body.error.message.includes('C:\\Users'))
  })

  test('BridgeError keeps its code through toFailure', () => {
    const body = JSON.parse(toFailure(new BridgeError('auth-required:login', 'please sign in')))
    assert.equal(body.error.code, 'auth-required:login')
  })

  test('digest is stable regardless of key order', () => {
    assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }))
    assert.notEqual(digest({ a: 1 }), digest({ a: 2 }))
  })

  test('audit record never carries raw arguments', () => {
    const record = auditRecord('tool.completed', {
      tool: 'webbridge_ask',
      args: { message: 'my secret prompt' },
      site: 'chatgpt',
      profile: 'webbridge',
      durationMs: 12,
      result: 'ok',
    })
    const text = JSON.stringify(record)
    assert.ok(!text.includes('my secret prompt'))
    assert.ok(text.includes('argsDigest'))
  })

  test('native browser driver initializes without a BrowserOperator dependency', () => {
    const driver = new BrowserDriver(settings)
    assert.equal(driver.currentKey(), '__webbridge_default__')
    assert.equal(driver.registryPath, join(tmp, 'sessions.json'))
  })

  console.log(`\n${passed} checks passed`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
