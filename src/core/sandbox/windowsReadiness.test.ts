// Whether a Codex home's elevated Windows sandbox is set up (sandbox design §10 item 1, inventory §23.3). Every `run`
// here is a fake: the real echo on a home that is not set up starts Codex's setup, and with it Windows' administrator
// prompt.
import { describe, expect, it } from 'vitest'
import os from 'node:os'
import {
  DOCTOR_ARGV,
  READY_MARKER,
  SETUP_ARGV,
  codexWindowsReadiness,
  codexWindowsSetup,
  forgetReadiness,
  provisioningOf,
  runCodex,
  type CodexRun
} from './windowsReadiness'

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

/** The account's permission profile as its sandboxed sessions get it (core/sandbox/prepared.ts hands the readiness the
 *  sessions' own `-c` values): the echo must run under it. Each elevated launch asks Codex to revoke the deny-read ACEs
 *  a home's last launch applied that its list lacks (windows-sandbox-rs/src/identity.rs:267-311, deny_read_state.rs:22-68
 *  at rust-v0.160.0). Windows keeps them today (REVOKE_ACCESS, windowsReadiness.ts), but an echo under any other list
 *  would lift what the running sessions deny the day Codex's revoke works. */
const PROFILE = [
  '-c',
  'permissions={astera={extends=":workspace", filesystem={"C:/Users/t/.ssh"="deny", "C:/Users/t/.npmrc"="deny"}, network={enabled=true}}}',
  '-c',
  'default_permissions="astera"',
  '-c',
  'windows.sandbox="elevated"'
]
const ECHO = ['sandbox', ...PROFILE, '--', 'cmd.exe', '/d', '/c', 'echo', 'ASTERA_SANDBOX_OK']

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
    expect(await codexWindowsReadiness({ codexHome: h, profile: PROFILE, run })).toBe('ready')
    // doctor first, then (only then) the echo, both against the account's own home
    expect(calls.map((c) => c.argv)).toEqual([DOCTOR_ARGV, ECHO])
    expect(calls.every((c) => c.env.CODEX_HOME === h)).toBe(true)
    expect(DOCTOR_ARGV).toEqual(['-c', 'windows.sandbox="elevated"', 'doctor', '--json'])
  })

  // Task K part 1: an echo under another list (the legacy read-only profile `codex sandbox` falls back to has none)
  // asks Codex to revoke the account's deny-read ACEs, and with them the E6 denials of its running sandboxed sessions
  // (which Windows keeps today, Task P, but not once Codex's revoke works). With no profile, or one that names no
  // `default_permissions` (codex would then fall back to that
  // read-only profile, cli/src/debug_sandbox.rs:713-731), the echo is not run and the home cannot be told ready.
  it("runs no echo without the account's own profile, and says so", async () => {
    for (const profile of [undefined, [], ['-c', 'windows.sandbox="elevated"']]) {
      const { run, calls } = fakeRun('complete')
      const logs: string[] = []
      const r = await codexWindowsReadiness({ codexHome: home(), run, log: (m) => logs.push(m), ...(profile ? { profile } : {}) })
      expect(r, JSON.stringify(profile)).toBe('check-failed')
      expect(calls.map((c) => c.argv), JSON.stringify(profile)).toEqual([DOCTOR_ARGV])
      expect(logs, JSON.stringify(profile)).toEqual([expect.stringMatching(/echo was not run.*profile/)])
    }
  })

  it('not set up when the echo fails or does not print the marker (a stale home)', async () => {
    for (const echo of [{ code: 1, out: 'sandbox error: logon failed' }, { code: 0, out: '' }]) {
      const { run } = fakeRun('complete', echo)
      expect(await codexWindowsReadiness({ codexHome: home(), profile: PROFILE, run }), JSON.stringify(echo)).toBe('not-set-up')
    }
  })

  // Task 2's text for a home with no setup: doctor's provisioning "incomplete", exit 1. The echo is never run there, since
  // on such a home it starts the setup and the administrator prompt.
  it("not set up on Task 2's text", async () => {
    const { run, calls } = fakeRun('incomplete')
    expect(await codexWindowsReadiness({ codexHome: home(), profile: PROFILE, run })).toBe('not-set-up')
    expect(calls.map((c) => c.argv)).toEqual([DOCTOR_ARGV])
  })

  // Task 6 fix round 1: only a report that reads "incomplete" is a home to set up. When Codex could not be asked at all,
  // setting up would not help, so the answer is its own, and the log says which case it was. The echo never runs on a
  // home doctor did not call complete.
  it('could not ask: codex missing, no doctor --json, a timeout, a report that does not read or names no provisioning', async () => {
    const cases: Array<{ name: string; run: CodexRun; log: RegExp; echoed?: true }> = [
      { name: 'codex missing', run: async () => Promise.reject(new Error('spawn codex ENOENT')), log: /could not be run: spawn codex ENOENT/ },
      { name: 'no doctor --json', run: async () => ({ code: 2, out: '', err: "error: unrecognized subcommand 'doctor'" }), log: /did not read.*exit 2.*unrecognized subcommand/ },
      { name: 'doctor timed out', run: async () => ({ code: null, out: '', err: 'killed' }), log: /did not answer/ },
      { name: 'not json', run: async () => ({ code: 0, out: 'not json' }), log: /did not read/ },
      { name: 'empty report', run: async () => ({ code: 0, out: '{}' }), log: /names no sandbox provisioning/ },
      { name: 'no provisioning', run: async () => ({ code: 0, out: JSON.stringify({ checks: { 'sandbox.helpers': { details: {} } } }) }), log: /names no sandbox provisioning/ },
      { name: 'an unknown provisioning', run: async () => ({ code: 0, out: JSON.stringify({ checks: { 'sandbox.helpers': { details: { 'sandbox provisioning': 'pending' } } } }) }), log: /"pending"/ },
      {
        name: 'echo timed out',
        run: async (argv) => (argv.includes('doctor') ? { code: 0, out: doctorOut('complete') } : { code: null, out: '' }),
        log: /echo did not answer/,
        echoed: true
      }
    ]
    for (const c of cases) {
      const argvs: string[][] = []
      const logs: string[] = []
      const r = await codexWindowsReadiness({ codexHome: home(), profile: PROFILE, run: async (argv, env) => (argvs.push(argv), c.run(argv, env)), log: (m) => logs.push(m) })
      expect(r, c.name).toBe('check-failed')
      expect(logs, c.name).toHaveLength(1)
      expect(logs[0], c.name).toMatch(c.log)
      expect(argvs, c.name).toEqual(c.echoed ? [DOCTOR_ARGV, ECHO] : [DOCTOR_ARGV])
    }
  })

  // Task 6 fix round 1: a setup that runs while a start is still asking makes that start's answer old; it is asked again
  it('an ask under way when a setup is forgotten does not answer, or keep, what it read before the setup', async () => {
    const h = home()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    let doctors = 0
    const run: CodexRun = async (argv) => {
      if (!argv.includes('doctor')) return { code: 0, out: READY_MARKER }
      doctors++
      if (doctors === 1) {
        await gate
        return { code: 0, out: doctorOut('complete') }
      }
      return { code: 1, out: doctorOut('incomplete') }
    }
    const asking = codexWindowsReadiness({ codexHome: h, profile: PROFILE, run })
    await Promise.resolve()
    forgetReadiness()
    release()
    expect(await asking).toBe('not-set-up')
    expect(doctors).toBe(2)
    // Nothing ready was kept from the first round
    const again = fakeRun('incomplete')
    expect(await codexWindowsReadiness({ codexHome: h, profile: PROFILE, run: again.run })).toBe('not-set-up')
    expect(again.calls).toHaveLength(1)
  })

  it('asked once per CODEX_HOME', async () => {
    const a = home()
    const b = home()
    const { run, calls } = fakeRun('complete')
    const both = await Promise.all([codexWindowsReadiness({ codexHome: a, profile: PROFILE, run }), codexWindowsReadiness({ codexHome: a, profile: PROFILE, run })])
    expect(both).toEqual(['ready', 'ready'])
    expect(await codexWindowsReadiness({ codexHome: a, profile: PROFILE, run })).toBe('ready')
    expect(calls).toHaveLength(2)
    // Another home is its own question
    expect(await codexWindowsReadiness({ codexHome: b, profile: PROFILE, run })).toBe('ready')
    expect(calls.filter((c) => c.env.CODEX_HOME === b)).toHaveLength(2)
  })

  // A not-set-up answer is not kept: the setup may run in another process (the Host runs 설정하기 while the app's own
  // managers ask too) or outside Astera, and asking such a home again runs doctor only, which brings up no prompt
  it('asks a home that is not set up again, and asks again after a setup is forgotten', async () => {
    const h = home()
    const unset = fakeRun('incomplete')
    expect(await codexWindowsReadiness({ codexHome: h, profile: PROFILE, run: unset.run })).toBe('not-set-up')
    const set = fakeRun('complete')
    expect(await codexWindowsReadiness({ codexHome: h, profile: PROFILE, run: set.run })).toBe('ready')
    // A setup of any home gives the machine's sandbox users new passwords, so a home kept as ready is asked again
    const other = home()
    expect(await codexWindowsReadiness({ codexHome: other, profile: PROFILE, run: set.run })).toBe('ready')
    forgetReadiness()
    const stale = fakeRun('complete', { code: 1, out: 'logon failure' })
    expect(await codexWindowsReadiness({ codexHome: other, profile: PROFILE, run: stale.run })).toBe('not-set-up')
    expect(await codexWindowsReadiness({ codexHome: h, profile: PROFILE, run: set.run })).toBe('ready')
  })

  it('the ambient account asks without CODEX_HOME', async () => {
    forgetReadiness()
    const { run, calls } = fakeRun('complete')
    expect(await codexWindowsReadiness({ codexHome: null, profile: PROFILE, run })).toBe('ready')
    expect(calls.every((c) => !('CODEX_HOME' in c.env))).toBe(true)
    forgetReadiness()
  })
})

// The real runner, with execFile injected: codex runs out of the temp folder, never out of whatever folder the asking
// process happens to be in, with the caller's variables over the session's and an unset one left out
describe('runCodex', () => {
  it('runs codex in the temp folder, with the environment it is given, and reads its exit', async () => {
    const seen: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = []
    const exec = ((file: string, args: string[], opts: Record<string, unknown>, cb: (err: Error | null, out: string, err2: string) => void) => {
      seen.push({ file, args, opts })
      cb(null, 'out', 'err')
    }) as unknown as Parameters<typeof runCodex>[2]
    const run = runCodex({ PATH: '/bin', CODEX_HOME: '/old', DROP: 'x' }, 1234, exec)
    expect(await run(DOCTOR_ARGV, { CODEX_HOME: '/h', DROP: undefined })).toEqual({ code: 0, out: 'out', err: 'err' })
    expect(seen[0].args.slice(-DOCTOR_ARGV.length)).toEqual(DOCTOR_ARGV)
    expect(seen[0].opts).toMatchObject({ cwd: os.tmpdir(), timeout: 1234, windowsHide: true, env: { PATH: '/bin', CODEX_HOME: '/h' } })
    expect(seen[0].opts.env).not.toHaveProperty('DROP')
    const failing = runCodex({}, 1, ((_f: string, _a: string[], _o: unknown, cb: (err: Error | null, out: string, e: string) => void) =>
      cb(Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }), '', '')) as unknown as Parameters<typeof runCodex>[2])
    expect(await failing(DOCTOR_ARGV, {})).toEqual({ code: null, out: '', err: 'spawn codex ENOENT' })
    const exited = runCodex({}, 1, ((_f: string, _a: string[], _o: unknown, cb: (err: Error | null, out: string, e: string) => void) =>
      cb(Object.assign(new Error('Command failed'), { code: 3 }), 'o', 'e')) as unknown as Parameters<typeof runCodex>[2])
    expect(await exited(DOCTOR_ARGV, {})).toEqual({ code: 3, out: 'o', err: 'e' })
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
    expect(await codexWindowsReadiness({ codexHome: h, profile: PROFILE, run: ready.run })).toBe('ready')
    const calls: Call[] = []
    const r = await codexWindowsSetup({ codexHome: h, run: async (argv, env) => (calls.push({ argv, env }), { code: 0, out: 'setup complete\n', err: '' }) })
    expect(SETUP_ARGV).toEqual(['sandbox', 'setup', '--elevated', '--current-user'])
    expect(calls).toEqual([{ argv: SETUP_ARGV, env: { CODEX_HOME: h } }])
    expect(r).toEqual({ ok: true, out: 'setup complete' })
    // The home is asked again at its next start
    const after = fakeRun('complete')
    await codexWindowsReadiness({ codexHome: h, profile: PROFILE, run: after.run })
    expect(after.calls).toHaveLength(2)
  })

  it('a refused or failed setup is not ok, with Codex’s own words, or its exit when it said nothing', async () => {
    expect(await codexWindowsSetup({ codexHome: home(), run: async () => ({ code: 1, out: '', err: 'Error: the elevation was cancelled\n' }) })).toEqual({
      ok: false,
      out: 'Error: the elevation was cancelled'
    })
    // Nothing said: no words of Codex's to show, so the app shows its own (session.spawn.sandbox.setUpFailed)
    expect(await codexWindowsSetup({ codexHome: home(), run: async () => ({ code: 3, out: '' }) })).toEqual({ ok: false, out: '' })
    expect(await codexWindowsSetup({ codexHome: home(), run: async () => Promise.reject(new Error('spawn codex ENOENT')) })).toEqual({
      ok: false,
      out: 'spawn codex ENOENT'
    })
  })
})
