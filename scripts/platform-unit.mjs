import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecretVault, keychain } from '../src/vault.js'
import { macSystemProxy, tunnelCommand } from '../src/tunnel.js'
import { runtimeFiles, macRuntimeArchive } from './prepare-tunnel-runtime.mjs'
import { detectChromeVersion } from '../src/driver.js'
import { currentPlatform } from '../src/browser-fingerprint.js'
import { resolveSettings, SITE_PRESETS, visibleSites } from '../src/config.js'

test('macOS Keychain persists and updates configuration without a plaintext file', { skip: process.platform !== 'darwin' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-keychain-test-'))
  const path = join(dir, 'config.enc')
  const vault = new SecretVault(path)
  const other = new SecretVault(join(dir, 'other.enc'))
  try {
    assert.equal(await vault.read(), null)
    const config = { tunnelId: 'tunnel_unit_test', runtimeApiKey: 'dummy-"quote\\slash\n中文', autoReconnect: true }
    await vault.write(config)
    assert.deepEqual(await new SecretVault(path).read(), config)
    assert.equal(await other.read(), null)
    await assert.rejects(access(path), { code: 'ENOENT' })
    await vault.write({ ...config, autoReconnect: false })
    assert.equal((await vault.read()).autoReconnect, false)
  } finally {
    await keychain('delete', vault.keychainAccount)
    await rm(dir, { recursive: true, force: true })
  }
})

test('macOS system proxy prefers enabled HTTPS and supports HTTP and IPv6', () => {
  assert.equal(macSystemProxy('HTTPEnable : 1\nHTTPProxy : localhost\nHTTPPort : 8888\nHTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897'), 'http://127.0.0.1:7897')
  assert.equal(macSystemProxy('HTTPEnable : 1\nHTTPProxy : ::1\nHTTPPort : 7897'), 'http://[::1]:7897')
  assert.equal(macSystemProxy('HTTPEnable : 0\nHTTPProxy : localhost\nHTTPPort : 7897'), null)
  assert.equal(macSystemProxy('<dictionary> {\n}'), null)
  assert.throws(() => macSystemProxy('HTTPSEnable : 1\nHTTPSProxy : user:secret@localhost\nHTTPSPort : 7897'))
  assert.throws(() => macSystemProxy('HTTPSEnable : 1\nHTTPSProxy : localhost\nHTTPSPort : 0'), /端口无效/)
})

test('PAC and SOCKS configurations request an explicit HTTP proxy', () => {
  assert.throws(() => macSystemProxy('ProxyAutoConfigEnable : 1'), /PAC/)
  assert.throws(() => macSystemProxy('ProxyAutoDiscoveryEnable : 1'), /PAC/)
  assert.throws(() => macSystemProxy('SOCKSEnable : 1'), /SOCKS/)
})

test('macOS tunnel uses Unix binaries while Windows retains exe companions', () => {
  assert.equal(runtimeFiles('darwin').runtime, 'tunnel-client-runtime-cloudflared')
  assert.equal(runtimeFiles('win32').cloudflared, 'cloudflared.exe')
  for (const suffix of ['', '.exe']) {
    const runtimePath = `/runtime/tunnel-client-runtime-cloudflared${suffix}`
    const spec = tunnelCommand({ tunnelId: 'tunnel_test', runtimeApiKey: 'dummy-key', healthPort: 18484 }, {
      runtimePath, mcpUrl: 'http://127.0.0.1:17877/mcp', mcpToken: 'dummy-mcp', env: {},
    })
    assert.equal(spec.options.env.CLOUDFLARED_PATH, `/runtime/cloudflared${suffix}`)
    assert.ok(!spec.args.join(' ').includes('dummy-key'))
  }
})

test('macOS release selection pins official Apple Silicon and Intel archives', () => {
  assert.ok(macRuntimeArchive('arm64').url.endsWith('darwin-arm64.zip'))
  assert.ok(macRuntimeArchive('x64').url.endsWith('darwin-amd64.zip'))
  assert.match(macRuntimeArchive('arm64').sha256, /^[a-f0-9]{64}$/)
  assert.notEqual(macRuntimeArchive('arm64').sha256, macRuntimeArchive('x64').sha256)
  assert.throws(() => macRuntimeArchive('ia32'), /不支持/)
})

test('macOS Chrome version comes from its app bundle instead of the Windows fallback', { skip: process.platform !== 'darwin' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-chrome-version-'))
  try {
    const root = join(dir, 'Google Chrome.app', 'Contents')
    const versions = join(root, 'Frameworks', 'Google Chrome Framework.framework', 'Versions')
    for (const name of ['157.0.8103.9', '157.0.8103.79', 'Current']) await mkdir(join(versions, name), { recursive: true })
    assert.equal(detectChromeVersion(join(root, 'MacOS', 'Google Chrome'), '124.0.0.0'), '157.0.8103.79')
    assert.equal(detectChromeVersion(join(dir, 'missing'), '124.0.0.0'), '124.0.0.0')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('platform defaults keep native navigator settings and the macOS new-chat shortcut', () => {
  assert.equal(resolveSettings().fingerprint.platform, currentPlatform())
  assert.equal(resolveSettings().fingerprint.navigator, false)
  assert.equal(SITE_PRESETS.chatgpt.newChatShortcut, process.platform === 'darwin' ? 'Meta+Shift+KeyO' : 'Control+Shift+KeyO')
})

test('site visibility defaults to ChatGPT and Gemini; other sites stay opt-in', () => {
  assert.deepEqual(visibleSites(resolveSettings()), ['chatgpt', 'gemini'])
  const reopened = resolveSettings({ sites: { visible: ['chatgpt', 'bigmodel', 'no-such-site'] } })
  assert.deepEqual(visibleSites(reopened), ['chatgpt', 'bigmodel'])
  assert.deepEqual(visibleSites(resolveSettings({ sites: { visible: [] } })), ['chatgpt'])
})
