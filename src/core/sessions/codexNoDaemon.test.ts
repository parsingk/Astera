import { describe, it, expect } from 'vitest'
import { makeCodexNoDaemonProbe } from './codexNoDaemon'
import type { SpawnCommand } from './commands'

const HELP_WITH = 'Options:\n  -c, --config <key=value>\n      --no-daemon\n          Run without the shared background server\n'
const HELP_WITHOUT = 'Options:\n  -c, --config <key=value>\n      --remote <ADDR>\n'
const SHIM = 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd'
const EXE = 'C:\\Users\\me\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe'

function harness(o: { platform?: NodeJS.Platform; help?: string | null; found?: string | null } = {}) {
  const runs: SpawnCommand[] = []
  let help = o.help === undefined ? HELP_WITH : o.help
  let id = 'v1'
  let t = 0
  const probe = makeCodexNoDaemonProbe({
    platform: o.platform ?? 'win32',
    resolve: () => (o.found === undefined ? EXE : o.found),
    run: (cmd) => {
      runs.push(cmd)
      return help
    },
    identity: (file) => `${file}|${id}`,
    now: () => t
  })
  return {
    probe,
    runs,
    setHelp: (h: string | null) => (help = h),
    update: (v: string) => (id = v),
    advance: (ms: number) => (t += ms)
  }
}

describe('makeCodexNoDaemonProbe', () => {
  it('says yes only when the binary’s help names --no-daemon', () => {
    expect(harness().probe()).toBe(true)
    expect(harness({ help: HELP_WITHOUT }).probe()).toBe(false)
  })

  it('asks the resolved binary itself, on win32 by its absolute path', () => {
    const h = harness()
    h.probe()
    expect(h.runs).toEqual([{ file: EXE, args: ['--help'] }])
  })

  it('asks an npm shim through the same cmd.exe wrapper a session uses', () => {
    const h = harness({ found: SHIM })
    h.probe()
    expect(h.runs).toEqual([{ file: 'cmd.exe', args: ['/d', '/c', 'call', SHIM, '--help'] }])
  })

  it('asks posix codex by name', () => {
    const h = harness({ platform: 'linux' })
    h.probe()
    expect(h.runs).toEqual([{ file: 'codex', args: ['--help'] }])
  })

  // An unknown flag stops codex from starting at all, so anything short of a clear yes is a no.
  it('says no when codex is not on PATH, without running anything', () => {
    const h = harness({ found: null })
    expect(h.probe()).toBe(false)
    expect(h.runs).toEqual([])
  })
  it('says no when the help could not be read', () => {
    expect(harness({ help: null }).probe()).toBe(false)
  })

  it('asks once per binary', () => {
    const h = harness()
    h.probe()
    h.probe()
    h.probe()
    expect(h.runs).toHaveLength(1)
  })

  it('asks again when the binary changes', () => {
    const h = harness({ help: HELP_WITHOUT })
    expect(h.probe()).toBe(false)
    h.setHelp(HELP_WITH)
    h.update('v2')
    expect(h.probe()).toBe(true)
    expect(h.runs).toHaveLength(2)
  })

  // posix codex is spawned by name and cannot be stat'ed here, so an update is only noticed by age.
  it('asks again after ten minutes even when nothing seems to have changed', () => {
    const h = harness({ platform: 'linux', help: HELP_WITHOUT })
    expect(h.probe()).toBe(false)
    h.setHelp(HELP_WITH)
    h.advance(9 * 60 * 1000)
    expect(h.probe()).toBe(false)
    h.advance(2 * 60 * 1000)
    expect(h.probe()).toBe(true)
  })
})
