// The elevated sandbox as a Codex home's default (Task P): Codex's own setup writes `windows.sandbox = "elevated"` into
// the home's config.toml, and every Codex session of that home then runs its commands in the elevated sandbox. Astera's
// sandboxed launches name it themselves, so after a setup Astera runs, the line is taken back out; one already there is
// only removed when the person asks. No codex runs here: the setup is a fake that writes what Codex writes.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeFixture } from '../testFixtures'
import {
  codexConfigFile,
  elevatedDefaultIn,
  removeElevatedDefault,
  setUpForSandboxedSessionsOnly,
  windowsSandboxDefaultOf,
  withoutElevatedDefault
} from './codexDefaultSandbox'
import { appServerSandboxArgs } from './codexProfile'
import { codexEchoArgs, sessionSandboxArgs } from './prepared'
import { DOCTOR_ARGV, READY_MARKER, codexWindowsDoctor, codexWindowsReadiness, readyArgv } from './windowsReadiness'
import { buildCodexAppServerCommand, buildCodexCommand, buildCodexSandboxCommand } from '../sessions/commands'

/** What Codex's setup leaves behind (cli/src/sandbox_setup.rs run_elevated → ConfigEditsBuilder::set_windows_sandbox_mode
 *  at rust-v0.160.0): toml_edit appends a new `[windows]` table after the file's last item, set apart by a blank line,
 *  and puts the key into the table when there is one already. */
const CODEX_TABLE = '[windows]\nsandbox = "elevated"\n'
const codexAdds = (before: string): string => (before === '' ? CODEX_TABLE : `${before}\n${CODEX_TABLE}`)

describe('windowsSandboxDefaultOf', () => {
  it('reads the table form, the dotted form and the inline form of the top-level key', () => {
    expect(windowsSandboxDefaultOf(codexAdds('model = "gpt-5"\n'))).toEqual({ kind: 'set', value: 'elevated', editable: true, table: true })
    expect(windowsSandboxDefaultOf('[ windows ] \n"sandbox" = \'unelevated\' # mine\n')).toEqual({ kind: 'set', value: 'unelevated', editable: true, table: true })
    expect(windowsSandboxDefaultOf('windows.sandbox = "elevated"\n[tui]\nx = 1\n')).toEqual({ kind: 'set', value: 'elevated', editable: true, table: false })
    expect(windowsSandboxDefaultOf('windows = { sandbox = "elevated" }\n')).toEqual({ kind: 'set', value: 'elevated', editable: false, table: false })
  })

  it('finds none where the key is not the top-level one, or sits in a multi-line string', () => {
    expect(windowsSandboxDefaultOf('')).toEqual({ kind: 'none', table: false })
    expect(windowsSandboxDefaultOf('model = "gpt-5"\n')).toEqual({ kind: 'none', table: false })
    expect(windowsSandboxDefaultOf('[profiles.work.windows]\nsandbox = "elevated"\n')).toEqual({ kind: 'none', table: false })
    expect(windowsSandboxDefaultOf('[tui]\nsandbox = "elevated"\n')).toEqual({ kind: 'none', table: false })
    expect(windowsSandboxDefaultOf('[windows]\nsandbox_private_desktop = true\n[tui]\nsandbox = "elevated"\n')).toEqual({ kind: 'none', table: true })
    expect(windowsSandboxDefaultOf('notes = """\n[windows]\nsandbox = "elevated"\n"""\n')).toEqual({ kind: 'none', table: false })
    expect(windowsSandboxDefaultOf('[tui]\nwindows.sandbox = "elevated"\n')).toEqual({ kind: 'none', table: false })
  })
})

describe('withoutElevatedDefault', () => {
  it('gives back exactly the file Codex found, whatever it held', () => {
    const befores = [
      '',
      'model = "gpt-5"\n',
      '# my settings\nmodel = "gpt-5"\n\n[projects."D:\\\\p\\\\a"]\ntrust_level = "trusted"\n',
      '[mcp_servers.x]\ncommand = "x" # keep\n\n\n[tui]\nnotifications = false\n'
    ]
    for (const before of befores) expect(withoutElevatedDefault(codexAdds(before), { dropEmptyTable: true }), before).toBe(before)
  })

  it('takes only the key out of a table that holds more, and keeps a table the person had', () => {
    const own = '[windows]\n# mine\nsandbox_private_desktop = true\nsandbox = "elevated"\n\n[tui]\nx = 1\n'
    expect(withoutElevatedDefault(own, { dropEmptyTable: true })).toBe('[windows]\n# mine\nsandbox_private_desktop = true\n\n[tui]\nx = 1\n')
    // A `[windows]` header that was there before the setup stays, empty, when the caller says so
    expect(withoutElevatedDefault('a = 1\n\n[windows]\nsandbox = "elevated"\n', { dropEmptyTable: false })).toBe('a = 1\n\n[windows]\n')
    // A header with a comment of its own is the person's
    expect(withoutElevatedDefault('a = 1\n\n[windows] # mine\nsandbox = "elevated"\n', { dropEmptyTable: true })).toBe('a = 1\n\n[windows] # mine\n')
  })

  it('keeps the blank line before the next table when the emptied one sat between two', () => {
    expect(withoutElevatedDefault('a = 1\n\n[windows]\nsandbox = "elevated"\n\n[tui]\nx = 1\n', { dropEmptyTable: true })).toBe('a = 1\n\n[tui]\nx = 1\n')
  })

  it("keeps the file's own line endings and byte-order mark", () => {
    const before = '\uFEFFmodel = "gpt-5"\r\n[tui]\r\nx = 1\r\n'
    // Codex's toml_edit writes its own lines with \n
    expect(withoutElevatedDefault(`${before}\n${CODEX_TABLE}`, { dropEmptyTable: true })).toBe(before)
    expect(withoutElevatedDefault('[windows]\r\nsandbox = "elevated"\r\nother = 1\r\n', { dropEmptyTable: true })).toBe('[windows]\r\nother = 1\r\n')
  })

  it('takes out the dotted form', () => {
    expect(withoutElevatedDefault('model = "gpt-5"\nwindows.sandbox = "elevated"\n[tui]\nx = 1\n', { dropEmptyTable: true })).toBe('model = "gpt-5"\n[tui]\nx = 1\n')
  })

  it('changes nothing it cannot take out exactly: no key, another value, an inline table', () => {
    for (const text of ['', 'model = "gpt-5"\n', '[windows]\nsandbox = "unelevated"\n', 'windows = { sandbox = "elevated" }\n', 'n = """\n[windows]\nsandbox = "elevated"\n"""\n'])
      expect(withoutElevatedDefault(text, { dropEmptyTable: true }), text).toBeNull()
  })
})

// Task P fix round 1 (review I2): Codex 0.160 still takes its older feature key `[features] elevated_windows_sandbox =
// true` as the elevated default when no `windows.sandbox` is set (core/src/windows_sandbox.rs:83-88, 97-106 at
// rust-v0.160.0), and its CLI setup does not clear it. So it counts as the elevated default too, and Remove takes it out
describe("Codex's older feature key", () => {
  it('is the elevated default when no windows.sandbox is set, in the table, dotted and inline forms', () => {
    expect(windowsSandboxDefaultOf('[features]\nelevated_windows_sandbox = true\n')).toEqual({ kind: 'legacy', editable: true, table: false })
    expect(windowsSandboxDefaultOf('model = "x"\n[ features ]\n"elevated_windows_sandbox" = true # old\n')).toEqual({ kind: 'legacy', editable: true, table: false })
    expect(windowsSandboxDefaultOf('features.elevated_windows_sandbox = true\n')).toEqual({ kind: 'legacy', editable: true, table: false })
    expect(windowsSandboxDefaultOf('features = { elevated_windows_sandbox = true }\n')).toEqual({ kind: 'legacy', editable: false, table: false })
    // windows.sandbox wins, as in Codex; false, the unelevated key and a profile's features are not it
    expect(windowsSandboxDefaultOf('[features]\nelevated_windows_sandbox = true\n[windows]\nsandbox = "unelevated"\n')).toEqual({ kind: 'set', value: 'unelevated', editable: true, table: true })
    for (const text of ['[features]\nelevated_windows_sandbox = false\n', '[features]\nexperimental_windows_sandbox = true\n', '[profiles.x.features]\nelevated_windows_sandbox = true\n', '[tui]\nelevated_windows_sandbox = true\n'])
      expect(windowsSandboxDefaultOf(text), text).toEqual({ kind: 'none', table: false })
  })

  it('comes out with the windows.sandbox line, leaving the rest of its table', () => {
    expect(withoutElevatedDefault('[features]\nother = true\nelevated_windows_sandbox = true\n', { dropEmptyTable: true })).toBe('[features]\nother = true\n')
    expect(withoutElevatedDefault('a = 1\n\n[features]\nelevated_windows_sandbox = true\n', { dropEmptyTable: true })).toBe('a = 1\n')
    expect(withoutElevatedDefault('features.elevated_windows_sandbox = true\na = 1\n', { dropEmptyTable: true })).toBe('a = 1\n')
    // Both: the line alone would leave the feature key making it the default again
    expect(withoutElevatedDefault('a = 1\n\n[features]\nelevated_windows_sandbox = true\n\n[windows]\nsandbox = "elevated"\n', { dropEmptyTable: true })).toBe('a = 1\n')
    expect(withoutElevatedDefault('[features]\nx = 1\nelevated_windows_sandbox = true\n\n[windows]\nsandbox = "elevated"\n[tui]\ny = 2\n', { dropEmptyTable: true })).toBe('[features]\nx = 1\n\n[tui]\ny = 2\n')
    // Not exactly: an inline features table, beside the line or alone
    expect(withoutElevatedDefault('features = { elevated_windows_sandbox = true }\n[windows]\nsandbox = "elevated"\n', { dropEmptyTable: true })).toBeNull()
    expect(withoutElevatedDefault('features = { elevated_windows_sandbox = true }\n', { dropEmptyTable: true })).toBeNull()
  })

  it('is read, taken out on disk, and left by a setup that found it there', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-codex-default-legacy-'))
    try {
      const file = path.join(dir, 'config.toml')
      await fs.writeFile(file, 'model = "x"\n\n[features]\nelevated_windows_sandbox = true\n')
      expect(await elevatedDefaultIn(file)).toBe(true)
      expect(await removeElevatedDefault(file, { dropEmptyTable: true })).toBe('removed')
      expect(await fs.readFile(file, 'utf8')).toBe('model = "x"\n')
      // A home first set up by an older Codex: the CLI setup adds windows.sandbox and keeps the feature key. The home already
      // made the elevated sandbox its default, so it is left, and the log does not say only sandboxed sessions use it
      const legacy = '[features]\nelevated_windows_sandbox = true\n'
      await fs.writeFile(file, legacy)
      const logs: string[] = []
      const setUp = async () => (await fs.writeFile(file, `${legacy}\n[windows]\nsandbox = "elevated"\n`), { ok: true, out: 'done' })
      await setUpForSandboxedSessionsOnly({ configFile: file, setUp, log: (m) => logs.push(m) })
      expect(await fs.readFile(file, 'utf8')).toBe(`${legacy}\n[windows]\nsandbox = "elevated"\n`)
      expect(logs).toEqual([expect.stringMatching(/already made the elevated sandbox its default.*elevated_windows_sandbox.*left/)])
      expect(logs.join('\n')).not.toMatch(/only sandboxed sessions/)
    } finally {
      await removeFixture(dir)
    }
  })
})

// Task P fix round 1 (review M1): the scanner reads triple quotes in a comment, in a one-line string or escaped inside a
// multi-line basic string as text, and a file that ends inside a multi-line string as one it cannot read with
// confidence: nothing is said to be set, and nothing is taken out
describe('a scan the file could throw off', () => {
  it('reads the reviewer’s desync inputs as TOML does', () => {
    const tail = '[windows]\nsandbox = "elevated"\n'
    // Triple quotes in a comment or a one-line string open nothing: the key is seen, and comes out
    for (const lead of ['# use """ for long text\nmodel = "x"\n\n', "note = \"it'''s\"\n\n", 'x = """a""""\n\n']) {
      expect(windowsSandboxDefaultOf(lead + tail), lead).toEqual({ kind: 'set', value: 'elevated', editable: true, table: true })
      expect(withoutElevatedDefault(lead + tail, { dropEmptyTable: true }), lead).toBe(lead.replace(/\n\n$/, '\n'))
    }
    // A key inside a real multi-line string is text: after a comment that holds triple quotes, and past an escaped quote
    for (const text of ['# """\nx = """\n[windows]\nsandbox = "elevated"\n"""\n', 'x = """a \\""" still inside\n[windows]\nsandbox = "elevated"\n"""\n']) {
      expect(windowsSandboxDefaultOf(text), text).toEqual({ kind: 'none', table: false })
      expect(withoutElevatedDefault(text, { dropEmptyTable: true }), text).toBeNull()
    }
  })

  it('cannot tell from a file that ends inside a multi-line string, and takes nothing out of it', async () => {
    const text = 'x = """\nnever closed\n[windows]\nsandbox = "elevated"\n'
    expect(windowsSandboxDefaultOf(text)).toEqual({ kind: 'unknown' })
    expect(withoutElevatedDefault(text, { dropEmptyTable: true })).toBeNull()
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-codex-default-unknown-'))
    try {
      const file = path.join(dir, 'config.toml')
      await fs.writeFile(file, text)
      expect(await removeElevatedDefault(file, { dropEmptyTable: true })).toBe('cannot-edit')
      expect(await fs.readFile(file, 'utf8')).toBe(text)
      expect(await fs.readdir(dir)).toEqual(['config.toml'])
      expect(await elevatedDefaultIn(file)).toBe(false)
    } finally {
      await removeFixture(dir)
    }
  })
})

describe('codexConfigFile', () => {
  it("is the config.toml in the session's CODEX_HOME, or in ~/.codex for the ambient account", () => {
    expect(codexConfigFile({ CODEX_HOME: path.join('h', '.codex-accounts', 'w') }, 'h')).toBe(path.join('h', '.codex-accounts', 'w', 'config.toml'))
    expect(codexConfigFile({}, 'h')).toBe(path.join('h', '.codex', 'config.toml'))
  })
})

// With the line gone, a set-up home must still run Astera's sandboxed launches elevated and still read set up. Codex
// takes a `-c` value over config.toml (SessionFlags, precedence 30, over the user's file, 20:
// config/src/config_layer_source.rs:33-51 at rust-v0.160.0), so each launch names the sandbox itself.
describe("a set-up home without the line in its config.toml", () => {
  const ELEVATED = ['-c', 'windows.sandbox="elevated"']
  const EXE = (): string => 'C:\\codex\\codex.exe'
  /** Whether `args` names the elevated sandbox as a `-c` pair before `stop` (a subcommand or `--`), where Codex reads it. */
  const namesElevated = (args: readonly string[], stop?: string): boolean => {
    const end = stop === undefined ? args.length : args.indexOf(stop)
    return args.slice(0, end).some((a, i) => a === ELEVATED[0] && args[i + 1] === ELEVATED[1])
  }
  const session = sessionSandboxArgs({ platform: 'win32', homeDir: 'C:/Users/t', layout: null, env: {}, readOnly: [], links: null })

  it('every sandboxed launch on Windows names the elevated sandbox itself', () => {
    // A terminal session, as its command builder puts the profile on the line
    expect(namesElevated(buildCodexCommand('win32', EXE, () => true)({ sandboxArgs: session }).args as string[])).toBe(true)
    // A chat's app-server
    expect(namesElevated(buildCodexAppServerCommand('win32', EXE, [], appServerSandboxArgs(session)).args)).toBe(true)
    // A Task's check, before the command it runs
    expect(namesElevated(buildCodexSandboxCommand('win32', appServerSandboxArgs(session), ['cmd.exe', '/c', 'npm test'], EXE).args, '--')).toBe(true)
    // The readiness echo, and doctor before its subcommand
    const echo = codexEchoArgs({ platform: 'win32', homeDir: 'C:/Users/t', layout: null, env: {}, readOnly: [], links: null })
    expect(namesElevated(readyArgv(echo), '--')).toBe(true)
    expect(namesElevated(DOCTOR_ARGV, 'doctor')).toBe(true)
  })

  /** Codex as cli/src/doctor/sandbox.rs answers at rust-v0.160.0: `sandbox provisioning` is reported only when the
   *  configured level is elevated (:125-136, :192-275), from a `-c` value or the home's config.toml; the echo runs in
   *  the elevated sandbox on the same terms. The home's setup itself is complete. */
  const codexOf = (configFile: string) => async (argv: string[]) => {
    const fromFile = await elevatedDefaultIn(configFile)
    const elevated = namesElevated(argv, argv.includes('--') ? '--' : 'doctor') || fromFile
    if (argv.includes('doctor')) {
      const details = elevated ? { 'sandbox backend': 'elevated', 'sandbox provisioning': 'complete' } : { 'sandbox backend': 'disabled' }
      return { code: 0, out: JSON.stringify({ checks: { 'sandbox.helpers': { details } } }) }
    }
    return elevated ? { code: 0, out: `${READY_MARKER}\r\n` } : { code: 1, out: 'commands ran outside any sandbox' }
  }

  it('reads ready: what readiness reads is doctor and the echo, which name the sandbox themselves', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-codex-default-ready-'))
    try {
      const file = path.join(dir, 'config.toml')
      await fs.writeFile(file, 'model = "gpt-5"\n')
      expect(await codexWindowsDoctor({ codexHome: dir, run: codexOf(file) })).toBe('ready')
      const echo = codexEchoArgs({ platform: 'win32', homeDir: 'C:/Users/t', layout: null, env: {}, readOnly: [], links: null })
      expect(await codexWindowsReadiness({ codexHome: dir, profile: echo, run: codexOf(file) })).toBe('ready')
    } finally {
      await removeFixture(dir)
    }
  })
})

describe('on disk', () => {
  let dir: string
  let file: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-codex-default-'))
    file = path.join(dir, 'config.toml')
  })
  afterEach(async () => {
    await removeFixture(dir)
  })

  it('removeElevatedDefault takes the line out through a temp file, keeping a .bak as the trust writer does', async () => {
    await fs.writeFile(file, codexAdds('model = "gpt-5"\n'))
    expect(await removeElevatedDefault(file, { dropEmptyTable: true })).toBe('removed')
    expect(await fs.readFile(file, 'utf8')).toBe('model = "gpt-5"\n')
    expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe(codexAdds('model = "gpt-5"\n'))
    expect((await fs.readdir(dir)).sort()).toEqual(['config.toml', 'config.toml.bak'])
  })

  // Fix round 1 (review M3): a config.toml that is a link (a dotfile manager's) stays a link; the line comes out of the
  // file it points to, where Codex writes it (utils/path-utils/src/lib.rs resolve_symlink_write_paths at
  // rust-v0.160.0). A link that points nowhere is cannot-edit, and nothing is written
  it('removeElevatedDefault writes through a config.toml that is a link, and never through one that points nowhere', async (ctx) => {
    const real = path.join(dir, 'dotfiles', 'codex.toml')
    await fs.mkdir(path.dirname(real))
    await fs.writeFile(real, codexAdds('model = "gpt-5"\n'))
    try {
      await fs.symlink(real, file, 'file')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip()
      throw e
    }
    expect(await removeElevatedDefault(file, { dropEmptyTable: true })).toBe('removed')
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(real, 'utf8')).toBe('model = "gpt-5"\n')
    await fs.rm(real)
    expect(await removeElevatedDefault(file, { dropEmptyTable: true })).toBe('cannot-edit')
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true)
    await expect(fs.stat(real)).rejects.toThrow()
  })

  it('removeElevatedDefault writes nothing when there is nothing it may take out', async () => {
    expect(await removeElevatedDefault(file, { dropEmptyTable: true })).toBe('absent')
    expect(await fs.readdir(dir)).toEqual([])
    for (const [text, outcome] of [
      ['model = "gpt-5"\n', 'absent'],
      ['[windows]\nsandbox = "unelevated"\n', 'other-value'],
      ['windows = { sandbox = "elevated" }\n', 'cannot-edit']
    ] as const) {
      await fs.writeFile(file, text)
      expect(await removeElevatedDefault(file, { dropEmptyTable: true })).toBe(outcome)
      expect(await fs.readFile(file, 'utf8')).toBe(text)
    }
    expect(await fs.readdir(dir)).toEqual(['config.toml'])
  })

  it('elevatedDefaultIn says whether the home makes the elevated sandbox its default', async () => {
    expect(await elevatedDefaultIn(file)).toBe(false)
    await fs.writeFile(file, codexAdds(''))
    expect(await elevatedDefaultIn(file)).toBe(true)
    await fs.writeFile(file, 'windows = { sandbox = "elevated" }\n')
    expect(await elevatedDefaultIn(file)).toBe(true)
    await fs.writeFile(file, '[windows]\nsandbox = "unelevated"\n')
    expect(await elevatedDefaultIn(file)).toBe(false)
  })

  describe('setUpForSandboxedSessionsOnly', () => {
    /** A setup that, like Codex's, writes the default only when it succeeds. */
    const codexSetup = (ok: boolean) => async () => {
      if (ok) {
        const before = await fs.readFile(file, 'utf8').catch(() => '')
        const d = windowsSandboxDefaultOf(before)
        await fs.writeFile(file, d.kind === 'set' ? before.replace(/sandbox = "[^"]*"/, 'sandbox = "elevated"') : codexAdds(before))
      }
      return { ok, out: ok ? 'Windows elevated sandbox setup completed' : 'cancelled' }
    }

    it("takes the line Codex added back out, so the home's other sessions run as before the setup", async () => {
      for (const before of [null, '', 'model = "gpt-5"\n', '# keep\n[tui]\nx = 1\n']) {
        if (before === null) await fs.rm(file, { force: true })
        else await fs.writeFile(file, before)
        const logs: string[] = []
        const r = await setUpForSandboxedSessionsOnly({ configFile: file, setUp: codexSetup(true), log: (m) => logs.push(m) })
        expect(r).toEqual({ ok: true, out: 'Windows elevated sandbox setup completed' })
        expect(await fs.readFile(file, 'utf8'), String(before)).toBe(before ?? '')
        expect(logs, String(before)).toEqual([expect.stringMatching(/took .*windows\.sandbox.* out of .*config\.toml/)])
      }
    })

    it('leaves an elevated default that was there before the setup, since whose it is cannot be told, and says so', async () => {
      await fs.writeFile(file, '[windows]\nsandbox = "elevated"\n')
      const logs: string[] = []
      await setUpForSandboxedSessionsOnly({ configFile: file, setUp: codexSetup(true), log: (m) => logs.push(m) })
      expect(await fs.readFile(file, 'utf8')).toBe('[windows]\nsandbox = "elevated"\n')
      expect(logs).toEqual([expect.stringMatching(/already set windows\.sandbox = "elevated" before the setup.*left/)])
    })

    // Fix round 1 (review I1): Codex's setup overwrites the person's own value with "elevated"
    // (core/src/config/edit.rs set_windows_sandbox_mode, keeping the line's decoration). Astera puts their line back,
    // byte for byte, where it was: nothing of Astera's reads the file's value
    it('puts back a value the person had set, exactly as it was, in the table or the dotted form', async () => {
      for (const [before, codexWrote] of [
        ['model = "x"\n\n[windows]\nsandbox = "unelevated" # mine\nother = 1\n', 'model = "x"\n\n[windows]\nsandbox = "elevated" # mine\nother = 1\n'],
        ["windows.sandbox = 'unelevated'\r\nmodel = \"x\"\r\n", 'windows.sandbox = "elevated"\r\nmodel = "x"\r\n']
      ]) {
        await fs.writeFile(file, before)
        const logs: string[] = []
        const setUp = async () => (await fs.writeFile(file, codexWrote), { ok: true, out: 'done' })
        await setUpForSandboxedSessionsOnly({ configFile: file, setUp, log: (m) => logs.push(m) })
        expect(await fs.readFile(file, 'utf8'), before).toBe(before)
        expect(await fs.readFile(`${file}.bak`, 'utf8'), before).toBe(codexWrote)
        expect(logs, before).toEqual([expect.stringMatching(/put back windows\.sandbox = "unelevated" in .*config\.toml/)])
      }
    })

    it('says what it could not put back, and writes nothing then', async () => {
      // An inline table it cannot write back exactly
      await fs.writeFile(file, 'windows = { sandbox = "unelevated" }\n')
      const logs: string[] = []
      const inline = async () => (await fs.writeFile(file, 'windows = { sandbox = "elevated" }\n'), { ok: true, out: 'done' })
      await setUpForSandboxedSessionsOnly({ configFile: file, setUp: inline, log: (m) => logs.push(m) })
      expect(await fs.readFile(file, 'utf8')).toBe('windows = { sandbox = "elevated" }\n')
      expect(logs).toEqual([expect.stringMatching(/could not put back windows\.sandbox = "unelevated".*inline table/)])
      // Codex left the person's value: nothing to put back
      await fs.writeFile(file, '[windows]\nsandbox = "unelevated"\n')
      const kept: string[] = []
      await setUpForSandboxedSessionsOnly({ configFile: file, setUp: async () => ({ ok: true, out: 'done' }), log: (m) => kept.push(m) })
      expect(await fs.readFile(file, 'utf8')).toBe('[windows]\nsandbox = "unelevated"\n')
      expect(kept).toEqual([expect.stringMatching(/still says windows\.sandbox = "unelevated"/)])
    })

    // Fix round 1 (review M4): what was checked, when nothing was found to take out
    it('says what it looked for when the setup left no line it could find', async () => {
      await fs.writeFile(file, 'model = "x"\n')
      const logs: string[] = []
      await setUpForSandboxedSessionsOnly({ configFile: file, setUp: async () => ({ ok: true, out: 'done' }), log: (m) => logs.push(m) })
      expect(logs).toEqual([expect.stringMatching(/no top-level windows\.sandbox line was found in .*config\.toml after the setup/)])
    })

    it('touches nothing after a setup that failed', async () => {
      await fs.writeFile(file, 'model = "gpt-5"\n')
      const logs: string[] = []
      expect(await setUpForSandboxedSessionsOnly({ configFile: file, setUp: codexSetup(false), log: (m) => logs.push(m) })).toEqual({ ok: false, out: 'cancelled' })
      expect(await fs.readdir(dir)).toEqual(['config.toml'])
      expect(logs).toEqual([])
    })

    it('leaves the line when the file could not be read before the setup: who set it cannot be told', async () => {
      // A folder where the file should be: reading it fails, as a locked or unreadable file would
      await fs.mkdir(file)
      const logs: string[] = []
      const r = await setUpForSandboxedSessionsOnly({ configFile: file, setUp: async () => ({ ok: true, out: '' }), log: (m) => logs.push(m) })
      expect(r.ok).toBe(true)
      expect(logs).toEqual([expect.stringMatching(/could not be read before the setup/)])
    })

    // Fix round 1 (review M1): a file this cannot read with confidence, before or after the setup, is left and said so
    it('leaves a file it cannot read with confidence, before or after the setup, and says so', async () => {
      const unclosed = 'x = """\nnever closed\n'
      await fs.writeFile(file, unclosed)
      const logs: string[] = []
      const setUp = async () => (await fs.writeFile(file, `${unclosed}[windows]\nsandbox = "elevated"\n`), { ok: true, out: 'done' })
      expect(await setUpForSandboxedSessionsOnly({ configFile: file, setUp, log: (m) => logs.push(m) })).toEqual({ ok: true, out: 'done' })
      expect(await fs.readFile(file, 'utf8')).toBe(`${unclosed}[windows]\nsandbox = "elevated"\n`)
      expect(logs).toEqual([expect.stringMatching(/cannot be read with confidence before the setup.*left/)])
      // Readable before, not after: the line Codex added cannot be found with confidence, so nothing is written
      await fs.writeFile(file, 'model = "x"\n')
      const after: string[] = []
      const breaks = async () => (await fs.writeFile(file, `model = "x"\n${unclosed}[windows]\nsandbox = "elevated"\n`), { ok: true, out: 'done' })
      await setUpForSandboxedSessionsOnly({ configFile: file, setUp: breaks, log: (m) => after.push(m) })
      expect(await fs.readFile(file, 'utf8')).toBe(`model = "x"\n${unclosed}[windows]\nsandbox = "elevated"\n`)
      expect(after).toEqual([expect.stringMatching(/could not take .*windows\.sandbox.* out.*cannot be read with confidence/)])
    })

    it('says so when the line Codex left cannot be taken out exactly, and never fails the setup for it', async () => {
      await fs.writeFile(file, '')
      const logs: string[] = []
      const setUp = async () => (await fs.writeFile(file, 'windows = { sandbox = "elevated" }\n'), { ok: true, out: 'done' })
      expect(await setUpForSandboxedSessionsOnly({ configFile: file, setUp, log: (m) => logs.push(m) })).toEqual({ ok: true, out: 'done' })
      expect(await fs.readFile(file, 'utf8')).toBe('windows = { sandbox = "elevated" }\n')
      expect(logs).toEqual([expect.stringMatching(/could not take .*windows\.sandbox.* out/)])
    })
  })
})
