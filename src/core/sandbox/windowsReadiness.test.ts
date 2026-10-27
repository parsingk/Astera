// Whether a Codex home's elevated Windows sandbox is set up (sandbox design §10 item 1, inventory §23.3). Every `run`
// here is a fake: the real echo on a home that is not set up starts Codex's setup, and with it Windows' administrator
// prompt.
import { describe, expect, it } from 'vitest'
import { DOCTOR_ARGV, READY_ARGV, READY_MARKER, SETUP_ARGV, codexWindowsReadiness, codexWindowsSetup, forgetReadiness, provisioningOf } from './windowsReadiness'

/** `codex doctor --json` as Task 2 read it: the provisioning under `sandbox.helpers`, complete for a set-up home, and for
 *  a scratch one the warning and its summary, with exit 1. */
const doctorOut = (provisioning: 'complete' | 'incomplete'): string =>
  JSON.stringify(
    {
      overallStatus: provisioning === 'complete' ? 'ok' : 'warning',
      checks: {
        'sandbox.helpers': {
          status: provisioning === 'complete' ? 'ok' : 'warning',
          ...(provisioning === 'complete'
            ? {}
            : {
                summary: 'elevated Windows sandbox provisioning is incomplete or outdated',
                remedy: 'run codex sandbox setup --elevated --user <end-user> --codex-home <authoritative-home> from an elevated shell'
              }),
          details: { 'sandbox provisioning': provisioning }
        }
      }
    },
    null,
    2
  )

type Call = { argv: string[]; env: Record<string, string | undefined> }

/** A run that answers doctor with `provisioning` and the echo with `echo`, and records every call. */
function fakeRun(provisioning: 'complete' | 'incomplete', echo: { code: number | null; out: string } = { code: 0, out: `${READY_MARKER}\r\n` }) {
  const calls: Call[] = []
  const run = async (argv: string[], env: Record<string, string | undefined>) => {
    calls.push({ argv, env })
    if (argv.includes('doctor')) return { code: provisioning === 'complete' ? 0 : 1, out: doctorOut(provisioning) }
    if (argv[0] === 'sandbox' && argv.includes('echo')) return echo
    throw new Error(`unexpected ${argv.join(' ')}`)
  }
  return { run, calls }
}

let homes = 0
/** A home of its own for each case, so the process-wide answers kept by one case never reach another. */
const home = (): string => `C:/Users/t/.codex-accounts/case-${++homes}`

describe('codexWindowsReadiness', () => {
  it('ready on the marker and exit 0', async () => {
    const h = home()
    const { run, calls } = fakeRun('complete')
    expect(await codexWindowsReadiness({ codexHome: h, run })).toBe('ready')
    // doctor first, then (only then) the echo, both against the account's own home
    expect(calls.map((c) => c.argv)).toEqual([DOCTOR_ARGV, READY_ARGV])
    expect(calls.every((c) => c.env.CODEX_HOME === h)).toBe(true)
    expect(DOCTOR_ARGV).toEqual(['-c', 'windows.sandbox="elevated"', 'doctor', '--json'])
    expect(READY_ARGV).toEqual(['sandbox', '-c', 'windows.sandbox="elevated"', '--', 'cmd.exe', '/d', '/c', 'echo', 'ASTERA_SANDBOX_OK'])
  })

  it('not set up when the echo fails or does not print the marker (a stale home)', async () => {
    for (const echo of [{ code: 1, out: 'sandbox error: logon failed' }, { code: 0, out: '' }, { code: null, out: READY_MARKER }]) {
      const { run } = fakeRun('complete', echo)
      expect(await codexWindowsReadiness({ codexHome: home(), run }), JSON.stringify(echo)).toBe('not-set-up')
    }
  })

  // Task 2's text for a home with no setup: doctor's provisioning "incomplete", exit 1. The echo is never run there, since
  // on such a home it starts the setup and the administrator prompt.
  it("not set up on Task 2's text", async () => {
    const { run, calls } = fakeRun('incomplete')
    expect(await codexWindowsReadiness({ codexHome: home(), run })).toBe('not-set-up')
    expect(calls.map((c) => c.argv)).toEqual([DOCTOR_ARGV])
    // A report that does not read, a run that throws, a doctor that names no provisioning: not set up, and no echo
    for (const out of ['not json', '{}', JSON.stringify({ checks: { 'sandbox.helpers': { details: {} } } })]) {
      const c: Call[] = []
      const r = await codexWindowsReadiness({ codexHome: home(), run: async (argv, env) => (c.push({ argv, env }), { code: 0, out }) })
      expect(r, out).toBe('not-set-up')
      expect(c.map((x) => x.argv), out).toEqual([DOCTOR_ARGV])
    }
    expect(await codexWindowsReadiness({ codexHome: home(), run: async () => Promise.reject(new Error('ENOENT')) })).toBe('not-set-up')
  })

  it('asked once per CODEX_HOME', async () => {
    const a = home()
    const b = home()
    const { run, calls } = fakeRun('complete')
    const both = await Promise.all([codexWindowsReadiness({ codexHome: a, run }), codexWindowsReadiness({ codexHome: a, run })])
    expect(both).toEqual(['ready', 'ready'])
    expect(await codexWindowsReadiness({ codexHome: a, run })).toBe('ready')
    expect(calls).toHaveLength(2)
    // Another home is its own question
    expect(await codexWindowsReadiness({ codexHome: b, run })).toBe('ready')
    expect(calls.filter((c) => c.env.CODEX_HOME === b)).toHaveLength(2)
  })

  // A not-set-up answer is not kept: the setup may run in another process (the Host runs 설정하기 while the app's own
  // managers ask too) or outside Astera, and asking such a home again runs doctor only, which brings up no prompt
  it('asks a home that is not set up again, and asks again after a setup is forgotten', async () => {
    const h = home()
    const unset = fakeRun('incomplete')
    expect(await codexWindowsReadiness({ codexHome: h, run: unset.run })).toBe('not-set-up')
    const set = fakeRun('complete')
    expect(await codexWindowsReadiness({ codexHome: h, run: set.run })).toBe('ready')
    // A setup of any home gives the machine's sandbox users new passwords, so a home kept as ready is asked again
    const other = home()
    expect(await codexWindowsReadiness({ codexHome: other, run: set.run })).toBe('ready')
    forgetReadiness()
    const stale = fakeRun('complete', { code: 1, out: 'logon failure' })
    expect(await codexWindowsReadiness({ codexHome: other, run: stale.run })).toBe('not-set-up')
    expect(await codexWindowsReadiness({ codexHome: h, run: set.run })).toBe('ready')
  })

  it('the ambient account asks without CODEX_HOME', async () => {
    forgetReadiness()
    const { run, calls } = fakeRun('complete')
    expect(await codexWindowsReadiness({ codexHome: null, run })).toBe('ready')
    expect(calls.every((c) => !('CODEX_HOME' in c.env))).toBe(true)
    forgetReadiness()
  })
})

describe('provisioningOf', () => {
  it("reads doctor's provisioning, also with other text around the report", () => {
    expect(provisioningOf(doctorOut('complete'))).toBe('complete')
    expect(provisioningOf(`warning: something\n${doctorOut('incomplete')}\n`)).toBe('incomplete')
    expect(provisioningOf('')).toBeNull()
  })
})

describe('codexWindowsSetup', () => {
  it("runs Task 2's setup command for the one home, says what Codex said, and forgets the answers kept", async () => {
    const h = home()
    const ready = fakeRun('complete')
    expect(await codexWindowsReadiness({ codexHome: h, run: ready.run })).toBe('ready')
    const calls: Call[] = []
    const r = await codexWindowsSetup({ codexHome: h, run: async (argv, env) => (calls.push({ argv, env }), { code: 0, out: 'setup complete\n', err: '' }) })
    expect(SETUP_ARGV).toEqual(['sandbox', 'setup', '--elevated', '--current-user'])
    expect(calls).toEqual([{ argv: SETUP_ARGV, env: { CODEX_HOME: h } }])
    expect(r).toEqual({ ok: true, out: 'setup complete' })
    // The home is asked again at its next start
    const after = fakeRun('complete')
    await codexWindowsReadiness({ codexHome: h, run: after.run })
    expect(after.calls).toHaveLength(2)
  })

  it('a refused or failed setup is not ok, with Codex’s own words, or its exit when it said nothing', async () => {
    expect(await codexWindowsSetup({ codexHome: home(), run: async () => ({ code: 1, out: '', err: 'Error: the elevation was cancelled\n' }) })).toEqual({
      ok: false,
      out: 'Error: the elevation was cancelled'
    })
    expect(await codexWindowsSetup({ codexHome: home(), run: async () => ({ code: 3, out: '' }) })).toEqual({ ok: false, out: 'codex sandbox setup exited with code 3' })
    expect(await codexWindowsSetup({ codexHome: home(), run: async () => Promise.reject(new Error('spawn codex ENOENT')) })).toEqual({
      ok: false,
      out: 'spawn codex ENOENT'
    })
  })
})
