import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PLUGIN_SERVED_CAPABILITIES, parseManifest } from '../core/plugins/manifest'
import { checkPluginFolder } from '../host/plugins/folderCheck'
import { PLUGIN_TEMPLATES, pluginTemplate } from './pluginTemplates'

// Phase 2 step 4a (spec E4 init): the four templates, UI only, a Host plugin, a completion check and a job source, each
// the smallest plugin of its kind that installs, in plain JavaScript with no dependency.
let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-plugin-templates-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const write = async (files: Record<string, string>, at: string): Promise<void> => {
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(at, rel)), { recursive: true })
    await fs.writeFile(path.join(at, rel), body)
  }
}

describe('plugin templates', () => {
  it('has the four the spec names', () => {
    expect([...PLUGIN_TEMPLATES]).toEqual(['ui', 'host', 'check', 'source'])
  })

  for (const kind of PLUGIN_TEMPLATES) {
    it(`${kind}: installs as written, named as asked, with a README`, async () => {
      const files = pluginTemplate(kind, '@acme/my-plugin')
      const at = path.join(dir, kind)
      await write(files, at)
      const r = await checkPluginFolder(at, { version: '1.6.0', capabilities: PLUGIN_SERVED_CAPABILITIES })
      expect(r.problems).toEqual([])
      expect(r.plugin).toMatchObject({ name: '@acme/my-plugin', version: '0.1.0', trust: kind === 'ui' ? 'restricted-ui' : 'trusted' })
      expect(Object.keys(files)).toContain('README.md')
      // No dependency to install: the folder installs as it is
      expect(JSON.parse(files['package.json']).dependencies).toBeUndefined()
    })
  }

  it('gives each kind its own capability and nothing it does not need', () => {
    const manifest = (kind: (typeof PLUGIN_TEMPLATES)[number]) => {
      const parsed = parseManifest(JSON.parse(pluginTemplate(kind, 'my-plugin')['package.json']))
      if (!parsed.ok) throw new Error(parsed.problems.join('; '))
      return parsed.manifest
    }
    expect(manifest('ui').contributes.panels).toEqual([{ id: 'main', title: 'My plugin' }])
    expect(manifest('ui').contributes.commands).toEqual([{ id: 'open', title: 'Open My plugin', panel: 'main' }])
    expect(manifest('host').permissions).toEqual(['projects.read'])
    expect(manifest('check')).toMatchObject({ capabilities: ['completion-check'], permissions: [] })
    expect(manifest('source')).toMatchObject({ capabilities: ['job-source'], permissions: [] })
  })

  it('keeps every page and script of the UI template to what a plugin page may do', () => {
    const files = pluginTemplate('ui', 'my-plugin')
    expect(files['ui/index.html']).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
    expect(files['ui/index.html']).not.toMatch(/\son[a-z]+=/i)
    for (const text of Object.values(files)) expect(text).not.toMatch(/https?:\/\/(?!localhost)/)
    expect(files['ui/panel.js']).toContain('window.astera.context()')
    expect(files['ui/panel.css']).toMatch(/color-scheme: dark;/)
  })
})
