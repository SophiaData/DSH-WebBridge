import { ChatgptModels } from './chatgpt.js'
import { BigmodelTrialModels } from './bigmodel.js'
import { GeminiModels } from './gemini.js'
import { join } from 'node:path'

/**
 * Channel model-source registry (strategy dispatch). The core flow never
 * branches on a site name: it looks the site up here and either uses the
 * strategy or falls back to the single generic model entry.
 *
 * Contract per strategy: see README.md in this folder.
 */
export function createModelSources({ settings, driver, log, emit }) {
  const onChangeFor = site => () => { try { emit(`webbridge-${site}`) } catch {} }
  const sources = {
    chatgpt: new ChatgptModels({ settings, driver, log, onChange: onChangeFor('chatgpt') }),
    bigmodel: new BigmodelTrialModels({ settings, driver, log, onChange: onChangeFor('bigmodel') }),
    gemini: new GeminiModels({ settings: { ...settings, providers: { ...(settings.providers || {}), geminiCatalogPath: join(settings.stateDir || '~/.dsh/webbridge', 'gemini-catalog.json') } }, driver, log, onChange: onChangeFor('gemini') }),
  }
  return sources
}

/** A site without a registered strategy gets the generic fallback. */
export function modelSourceFor(sources, site) {
  return sources[site] || null
}
