import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { SESSION_CONTEXT_SCRIPT, codexDeveloperInstructions, sessionContextLines } from './sessionContext'
import { LAUNCH_FORBIDDEN } from './commands'

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

  // The codex side decides its lines in TypeScript; the hook script decides them in its own copy. This
  // runs both over the same settings so the two cannot drift.
  it('decides the same lines as sessionContextLines', async () => {
    const hf = { accounts: [{ id: 'a', label: 'A' }], current: 'a' }
    const cases: Array<[unknown, unknown]> = [
      [{}, undefined],
      [{ agentAppEnabled: true }, undefined],
      [{ agentBrowserEnabled: true, workUnitTrackingEnabled: true }, hf],
      [{ agentAppEnabled: true, agentBrowserEnabled: true, workUnitTrackingEnabled: true, resumeStrategy: 'smart' }, hf]
    ]
    for (const [s, h] of cases) {
      await fs.rm(path.join(dir, 'higgsfield'), { recursive: true, force: true })
      expect(await run(s, { ASTERA_CLI: 'x' }, h)).toBe(sessionContextLines(s, h ?? null).join('\n'))
    }
  })
})

describe('codexDeveloperInstructions', () => {
  const ALL_ON = { agentAppEnabled: true, agentBrowserEnabled: true, workUnitTrackingEnabled: true, resumeStrategy: 'smart' }
  const HF = { accounts: [{ id: 'a', label: 'A' }], current: 'a' }
  function files(o: { settings?: unknown; hf?: unknown; codexConfig?: string }) {
    const map = new Map<string, string>()
    if (o.settings !== undefined) map.set(path.join('P', 'app-settings.json'), JSON.stringify(o.settings))
    if (o.hf !== undefined) map.set(path.join('P', 'higgsfield', 'accounts.json'), JSON.stringify(o.hf))
    if (o.codexConfig !== undefined) map.set(path.join('C', 'config.toml'), o.codexConfig)
    return (p: string): string | null => map.get(p) ?? null
  }
  const brief = (o: Parameters<typeof files>[0]) => codexDeveloperInstructions({ profileDir: 'P', codexHome: 'C', read: files(o) })

  it('tells a codex session what the hook tells a Claude one, on one line', () => {
    const t = brief({ settings: ALL_ON, hf: HF })!
    expect(t).not.toContain('\n')
    expect(t.startsWith('This session runs inside Astera.')).toBe(true)
    for (const s of ['astera app js', 'astera browser help', '/astera-task', 'astera handoff', 'astera higgsfield list', 'Full list'])
      expect(t).toContain(s)
  })

  // An npm-installed codex starts through `cmd.exe /c call`, which reads these as syntax.
  it('carries nothing cmd.exe would read as syntax, with every feature on', () => {
    expect(LAUNCH_FORBIDDEN.test(brief({ settings: ALL_ON, hf: HF })!)).toBe(false)
  })

  it('drops the lines of the features that are off, as the hook does', () => {
    const t = brief({ settings: {} })!
    expect(t).toContain('astera help')
    expect(t).not.toContain('astera app js')
  })

  // `-c developer_instructions` replaces the account's own value; the person's instructions win.
  it('steps aside when the account sets its own developer_instructions', () => {
    expect(brief({ settings: ALL_ON, codexConfig: 'model = "x"\ndeveloper_instructions = "mine"\n' })).toBeNull()
  })
  it('does not mistake a key inside a table for the account’s own', () => {
    expect(brief({ settings: ALL_ON, codexConfig: '[profiles.fast]\ndeveloper_instructions = "x"\n' })).not.toBeNull()
  })
})
