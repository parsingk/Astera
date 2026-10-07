import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { SESSION_CONTEXT_SCRIPT } from './sessionContext'

describe('SessionStart context script', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-ctx-'))
    await fs.writeFile(path.join(dir, 'script.cjs'), SESSION_CONTEXT_SCRIPT, 'utf8')
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  async function run(settings: unknown | null, env: Record<string, string> = { ASTERA_CLI: 'x' }, hf?: unknown) {
    if (settings !== null) await fs.writeFile(path.join(dir, 'app-settings.json'), JSON.stringify(settings))
    if (hf) {
      await fs.mkdir(path.join(dir, 'higgsfield'), { recursive: true })
      await fs.writeFile(path.join(dir, 'higgsfield', 'accounts.json'), JSON.stringify(hf))
    }
    const r = spawnSync(process.execPath, [path.join(dir, 'script.cjs')], {
      input: '{}', encoding: 'utf8', env: { ...process.env, ASTERA_CLI: '', ASTERA_PROFILE_DIR: dir, ...env }
    })
    expect(r.stderr).toBe(''); expect(r.status).toBe(0)
    if (r.stdout.trim() === '') return null
    const j = JSON.parse(r.stdout)
    expect(j.hookSpecificOutput.hookEventName).toBe('SessionStart')
    return j.hookSpecificOutput.additionalContext as string
  }

  it('prints valid hook JSON, always naming orchestration and the full list', async () => {
    const t = await run({})
    expect(t).toContain('This session runs inside Astera')
    expect(t).toContain('`astera help`')
    expect(t!.split('\n').length).toBeLessThanOrEqual(12)
  })

  it('drops the line of every feature that is off', async () => {
    const off = (await run({}))!
    expect(off).not.toContain('astera app js')
    expect(off).not.toContain('astera browser help')
    expect(off).not.toContain('/astera-task')
    expect(off).not.toContain('astera handoff')
    expect(off).not.toContain('higgsfield')
  })

  it('adds the lines of the features that are on', async () => {
    const on = (await run(
      { agentAppEnabled: true, agentBrowserEnabled: true, workUnitTrackingEnabled: true, resumeStrategy: 'smart' },
      { ASTERA_CLI: 'x' },
      { accounts: [{ id: 'a', label: 'A' }], current: 'a' }
    ))!
    expect(on).toContain('astera app js')
    expect(on).toContain('Never launch the app on the person')
    expect(on).toContain('astera browser help')
    expect(on).toContain('/astera-task')
    expect(on).toContain('astera handoff')
    expect(on).toContain('astera higgsfield list')
  })

  it('a missing or unreadable settings file reads as everything off, not as a failure', async () => {
    expect(await run(null)).toContain('inside Astera')
    await fs.writeFile(path.join(dir, 'app-settings.json'), '{not json')
    expect(await run(null)).not.toContain('astera app js')
  })

  it('prints nothing outside a session Astera started (no ASTERA_CLI)', async () => {
    expect(await run({ agentAppEnabled: true }, {})).toBeNull()
  })
})
