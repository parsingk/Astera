import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_COMMAND_PERMISSIONS, SDK_COMMANDS_CLOSED_TO_PLUGINS, pluginRefusal } from './pluginGate'
import { PLUGIN_PERMISSIONS } from '../plugins/manifest'

const plugin = (granted: string[]) => ({ id: 'astera-hello', granted: new Set(granted) })

describe('pluginRefusal (plugin runtime design P12)', () => {
  it('admits each command with its permission and refuses it without, naming both', () => {
    for (const [cmd, permission] of Object.entries(PLUGIN_COMMAND_PERMISSIONS)) {
      expect(pluginRefusal(cmd, plugin([permission])), cmd).toBeNull()
      expect(pluginRefusal(cmd, plugin(PLUGIN_PERMISSIONS.filter((p) => p !== permission))), cmd).toEqual({
        status: 403,
        body: { error: `${cmd} needs the ${permission} permission, which plugin astera-hello was not granted` }
      })
    }
  })

  it('is design §2’s table', () => {
    expect(PLUGIN_COMMAND_PERMISSIONS).toEqual({
      'projects-list': 'projects.read',
      'projects-get': 'projects.read',
      'jobs-list': 'jobs.read',
      'jobs-get': 'jobs.read',
      'jobs-wait': 'jobs.read',
      'jobs-create': 'jobs.create',
      'jobs-run': 'jobs.run',
      'runs-list': 'runs.read',
      'runs-get': 'runs.read',
      'runs-wait': 'runs.read',
      'runs-follow': 'runs.read',
      'runs-stop': 'runs.control',
      'runs-resume': 'runs.control',
      'tasks-list': 'tasks.read',
      'tasks-get': 'tasks.read',
      'tasks-add': 'tasks.write',
      'questions-list': 'questions.read',
      'questions-get': 'questions.read',
      'questions-answer': 'questions.answer',
      'runs-completion': 'completion.read',
      'events-poll': 'events.subscribe'
    })
  })

  it('admits requests-show with no permission: it reads only the plugin’s own receipts', () => {
    expect(pluginRefusal('requests-show', plugin([]))).toBeNull()
  })

  it('refuses what no plugin reaches, whatever it was granted', () => {
    for (const cmd of ['state-put', 'plugins-install', 'plugins-list', 'app-js', 'runtime-status', 'sessions-send', 'sources-list', 'sources-items', 'sources-show', 'jobs-create-from-source', 'a-command-added-later'])
      expect(pluginRefusal(cmd, plugin([...PLUGIN_PERMISSIONS])), cmd).toEqual({ status: 403, body: { error: `${cmd} is not available to plugins` } })
  })

  // Observe mode design §3, §12: no plugin reads the audit log or the rules, whatever it was granted
  it('never maps an audit or policies command, and refuses each whatever was granted', () => {
    for (const cmd of [...Object.keys(PLUGIN_COMMAND_PERMISSIONS), ...SDK_COMMANDS_CLOSED_TO_PLUGINS]) expect(cmd).not.toMatch(/^(?:audit|policies)-/)
    for (const cmd of ['audit-list', 'audit-summary', 'policies-show', 'policies-set-mode', 'policies-set-otherwise', 'policies-rules-add', 'policies-rules-edit', 'policies-rules-remove', 'policies-rules-move', 'policies-rules-reset'])
      expect(pluginRefusal(cmd, plugin([...PLUGIN_PERMISSIONS])), cmd).toEqual({ status: 403, body: { error: `${cmd} is not available to plugins` } })
  })

  it('refuses a call that names no plugin', () => {
    expect(pluginRefusal('projects-list', undefined)).toEqual({ status: 403, body: { error: 'a plugin call needs its plugin' } })
  })

  // Design §2: every command the SDK sends has exactly one permission, so the SDK a plugin is handed is all usable.
  it('maps every command the SDK sends', () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../packages/client/src')
    const sent = new Set<string>()
    for (const f of ['namespaces.ts', 'events.ts', 'follow.ts'])
      for (const m of readFileSync(path.join(src, f), 'utf8').matchAll(/'([a-z]+(?:-[a-z]+)+)'/g)) sent.add(m[1])
    expect([...sent].filter((c) => !SDK_COMMANDS_CLOSED_TO_PLUGINS.has(c)).sort()).toEqual(Object.keys(PLUGIN_COMMAND_PERMISSIONS).sort())
    // The ones held back are commands the SDK really sends, and every permission still refuses them
    for (const cmd of SDK_COMMANDS_CLOSED_TO_PLUGINS) {
      expect(sent.has(cmd), cmd).toBe(true)
      expect(pluginRefusal(cmd, { id: 'p', granted: new Set(Object.values(PLUGIN_COMMAND_PERMISSIONS)) })?.status, cmd).toBe(403)
    }
  })
})
