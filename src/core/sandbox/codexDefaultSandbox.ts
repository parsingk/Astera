// The elevated sandbox as a Codex home's default (Task P; the person's decision, 2026-10-29). Codex's
// `codex sandbox setup --elevated` provisions the home and then always writes `windows.sandbox = "elevated"` into its
// config.toml (cli/src/sandbox_setup.rs:104-117, core/src/config/edit.rs set_windows_sandbox_mode, at rust-v0.160.0).
// With that line every Codex session of the home runs its commands in the elevated sandbox, as the sandbox's own
// account: an Astera tab with YOLO off, a How It Works write-up, the person's own `codex`. That account is kept out of
// the login folders by the denials Astera's sandboxed sessions leave on the machine's sandbox users group, which stay
// (windowsReadiness.ts says why), and on a home another account's setup made stale such a command can bring up the
// administrator prompt. Astera's own sandboxed launches do not need the line: each names the elevated sandbox itself
// (codexProfile.ts codexSandboxArgs, windowsReadiness.ts DOCTOR_ARGV). So after a setup Astera runs, the line Codex added
// is taken back out (setUpForSandboxedSessionsOnly). A line that was there before, the person's or an earlier setup's,
// stays until the person removes it in Settings › Agent profiles, and a sandboxed start on such a home says so
// (startWarnings.ts).
//
// The file is the person's: it is edited as codexTrust.ts edits it, line by line with nothing parsed and re-serialised,
// one change at a time per file, through a temp file, with a .bak beside it. Main and the Host only: this reads files.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { togglesMultiline } from '../accounts/codexTrust'
import { oneAtATime, writeThroughTmp } from '../accounts/fileQueue'
import { readStoreFile } from '../storeFile'

/** The top-level `windows.sandbox` of a config.toml: none (`table`: a `[windows]` table is there all the same), or its
 *  value, with whether this module can take it out exactly (`editable`: a string value on a line of its own). */
export type WindowsSandboxDefault =
  | { kind: 'none'; table: boolean }
  | { kind: 'set'; value: string; editable: boolean; table: boolean }

/** A line and the line break after it, kept apart so the file goes back together byte for byte: Codex writes its own
 *  lines with \n into a file that may break them with \r\n. The last entry is what follows the last break. */
interface Line {
  text: string
  end: string
}

function linesOf(content: string): Line[] {
  const parts = content.split(/(\r\n|\n)/)
  const out: Line[] = []
  for (let i = 0; i < parts.length; i += 2) out.push({ text: parts[i], end: parts[i + 1] ?? '' })
  return out
}

const BOM = String.fromCharCode(0xfeff)
/** A line's text as TOML reads it: the first one without the file's byte-order mark. */
const bare = (lines: Line[], i: number): string => (i === 0 && lines[0].text.startsWith(BOM) ? lines[0].text.slice(1) : lines[i].text)

const ANY_HEADER = /^\s*\[/
const WINDOWS_HEADER = /^\s*\[\s*(?:windows|"windows"|'windows')\s*\]\s*(?:#.*)?$/
/** A `[windows]` header with nothing else on its line: one with a comment of its own is the person's to keep. */
const BARE_WINDOWS_HEADER = /^\s*\[\s*(?:windows|"windows"|'windows')\s*\]\s*$/
const SANDBOX_KEY = /^\s*(?:sandbox|"sandbox"|'sandbox')\s*=(.*)$/
const DOTTED_KEY = /^\s*(?:windows|"windows"|'windows')\s*\.\s*(?:sandbox|"sandbox"|'sandbox')\s*=(.*)$/
const INLINE_TABLE = /^\s*(?:windows|"windows"|'windows')\s*=\s*\{(.*)\}\s*(?:#.*)?$/
const INLINE_SANDBOX = /(?:^|[{,\s])(?:sandbox|"sandbox"|'sandbox')\s*=\s*(?:"([^"\\]*)"|'([^']*)')/
const STRING_VALUE = /^\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/

const valueOf = (rhs: string): { value: string; editable: boolean } => {
  const m = STRING_VALUE.exec(rhs)
  return m ? { value: m[1] ?? m[2], editable: true } : { value: rhs.trim(), editable: false }
}

/** Where the setting is: its line, its form, and the `[windows]` table's header and end (the line after its last). */
interface Located {
  setting: WindowsSandboxDefault
  line: number | null
  form: 'table' | 'dotted' | 'inline' | null
  header: number | null
  end: number
}

function locate(lines: Line[]): Located {
  let multiline: '"""' | "'''" | null = null
  let where: 'root' | 'windows' | 'other' = 'root'
  let header: number | null = null
  let end = lines.length
  let found: { line: number; form: 'table' | 'dotted' | 'inline'; value: string; editable: boolean } | null = null
  for (let i = 0; i < lines.length; i++) {
    const text = bare(lines, i)
    if (multiline === null) {
      if (ANY_HEADER.test(text)) {
        if (where === 'windows') end = i
        // The first `[windows]` only (a second is not TOML), never an array of tables
        if (header === null && !text.trimStart().startsWith('[[') && WINDOWS_HEADER.test(text)) {
          header = i
          where = 'windows'
        } else where = 'other'
      } else if (found === null && where === 'root') {
        const dotted = DOTTED_KEY.exec(text)
        const inline = dotted ? null : INLINE_TABLE.exec(text)
        const s = inline ? INLINE_SANDBOX.exec(inline[1]) : null
        if (dotted) found = { line: i, form: 'dotted', ...valueOf(dotted[1]) }
        else if (s) found = { line: i, form: 'inline', value: s[1] ?? s[2], editable: false }
      } else if (found === null && where === 'windows') {
        const key = SANDBOX_KEY.exec(text)
        if (key) found = { line: i, form: 'table', ...valueOf(key[1]) }
      }
    }
    multiline = togglesMultiline(text, multiline)
  }
  const table = header !== null
  return {
    setting: found ? { kind: 'set', value: found.value, editable: found.editable, table } : { kind: 'none', table },
    line: found?.line ?? null,
    form: found?.form ?? null,
    header,
    end: table ? end : lines.length
  }
}

/** The top-level `windows.sandbox` a config.toml sets (WindowsSandboxDefault). Only the top-level key: a profile's, or
 *  a key of that name in another table, is not the home's default, and text inside a multi-line string is not a key. */
export function windowsSandboxDefaultOf(text: string): WindowsSandboxDefault {
  return locate(linesOf(text)).setting
}

/**
 * `text` without its `windows.sandbox = "elevated"`, everything else as it was, or null when there is nothing this may
 * take out exactly: no such key, another value, an inline `windows = { … }` table. With `dropEmptyTable`, a `[windows]`
 * header left with nothing under it goes too, with the blank line before it when nothing follows: what Codex appends to
 * a file that had no such table (a blank line, the header, the key) then comes back out whole. A header that carries a
 * comment stays.
 */
export function withoutElevatedDefault(text: string, opts: { dropEmptyTable: boolean }): string | null {
  const lines = linesOf(text)
  const at = locate(lines)
  if (at.setting.kind !== 'set' || at.setting.value !== 'elevated' || !at.setting.editable || at.line === null) return null
  const drop = new Set<number>([at.line])
  if (at.form === 'table' && opts.dropEmptyTable && at.header !== null && BARE_WINDOWS_HEADER.test(bare(lines, at.header))) {
    const rest: number[] = []
    for (let i = at.header + 1; i < at.end; i++) if (i !== at.line) rest.push(i)
    if (rest.every((i) => lines[i].text.trim() === '')) {
      drop.add(at.header)
      for (const i of rest) drop.add(i)
      const follows = lines.slice(at.end).some((l) => l.text !== '' || l.end !== '')
      if (!follows && at.header > 0 && bare(lines, at.header - 1).trim() === '') drop.add(at.header - 1)
    }
  }
  const out = lines
    .filter((_, i) => !drop.has(i))
    .map((l) => l.text + l.end)
    .join('')
  return text.startsWith(BOM) && !out.startsWith(BOM) ? BOM + out : out
}

/** The config.toml Codex reads for a session started with `env`: its CODEX_HOME's, or ~/.codex's for the ambient
 *  account, which starts with none (cliEnvFor), as codexDeveloperInstructions names it. */
export const codexConfigFile = (env: Record<string, string | undefined>, homeDir: string): string =>
  path.join(env.CODEX_HOME ?? path.join(homeDir, '.codex'), 'config.toml')

/** Whether the config.toml at `file` makes the elevated sandbox its home's default, in any form (an inline table
 *  included, which removeElevatedDefault cannot take out). One that is not there or cannot be read does not: this is a
 *  hint, never a gate. */
export async function elevatedDefaultIn(file: string): Promise<boolean> {
  const read = await readStoreFile(file)
  if (read.kind !== 'text') return false
  const d = windowsSandboxDefaultOf(read.text)
  return d.kind === 'set' && d.value === 'elevated'
}

/** What removeElevatedDefault did: took the line out, found none, found another value (left), or found one it cannot
 *  take out exactly (left: an inline table). */
export type RemoveOutcome = 'removed' | 'absent' | 'other-value' | 'cannot-edit'

/** Takes `windows.sandbox = "elevated"` out of the config.toml at `file` (withoutElevatedDefault), as
 *  markCodexProjectTrusted writes that file: one change at a time per file, the old one kept as .bak, the new one through
 *  a temp file and a rename. Writes nothing when there is nothing it may take out. Rejects when the file cannot be read
 *  or written. */
export async function removeElevatedDefault(file: string, opts: { dropEmptyTable: boolean }): Promise<RemoveOutcome> {
  let outcome: RemoveOutcome = 'absent'
  await oneAtATime(file, async () => {
    const read = await readStoreFile(file)
    if (read.kind === 'unreadable') throw read.error
    if (read.kind === 'missing') return
    const d = windowsSandboxDefaultOf(read.text)
    if (d.kind === 'none') return
    if (d.value !== 'elevated') {
      outcome = 'other-value'
      return
    }
    const next = withoutElevatedDefault(read.text, opts)
    if (next === null) {
      outcome = 'cannot-edit'
      return
    }
    await fs.copyFile(file, file + '.bak').catch(() => {})
    await writeThroughTmp(file, next)
    outcome = 'removed'
  })
  return outcome
}

const WHY: Record<Exclude<RemoveOutcome, 'removed' | 'absent'>, string> = {
  'other-value': 'it names another sandbox now, which is left as it is',
  'cannot-edit': 'it is not on a line of its own (an inline table), so it is left; Settings › Agent profiles names it'
}

/**
 * Codex's setup of one home (`setUp`, windowsReadiness.ts codexWindowsSetup) for Astera's sandboxed sessions only: the
 * file is read first, and after a setup that worked, the `windows.sandbox = "elevated"` line Codex added is taken back
 * out (removeElevatedDefault; a `[windows]` table Codex made for it goes too). A file that already set
 * `windows.sandbox` before, to this value or another, is the person's and is left; so is one that could not be read
 * before, since who set the line then cannot be told (Settings › Agent profiles asks). Each way is logged. The setup's
 * own answer is returned as it was: nothing here fails it. Never rejects.
 */
export async function setUpForSandboxedSessionsOnly(a: {
  configFile: string
  setUp: () => Promise<{ ok: boolean; out: string }>
  log: (m: string) => void
}): Promise<{ ok: boolean; out: string }> {
  const before = await readStoreFile(a.configFile)
  const r = await a.setUp()
  if (!r.ok) return r
  if (before.kind === 'unreadable') {
    a.log(
      `sandbox: ${a.configFile} could not be read before the setup, so whether its windows.sandbox line is Codex's cannot be told; it is left for Settings › Agent profiles (${String(before.error)})`
    )
    return r
  }
  const was = before.kind === 'text' ? windowsSandboxDefaultOf(before.text) : ({ kind: 'none', table: false } as const)
  if (was.kind === 'set') {
    a.log(`sandbox: ${a.configFile} already set windows.sandbox before the setup ("${was.value}"), so the line is left as it is`)
    return r
  }
  try {
    const outcome = await removeElevatedDefault(a.configFile, { dropEmptyTable: !was.table })
    a.log(
      outcome === 'removed'
        ? `sandbox: took the windows.sandbox = "elevated" line Codex's setup added out of ${a.configFile}, so only sandboxed sessions run in the elevated sandbox`
        : outcome === 'absent'
          ? `sandbox: the setup left no windows.sandbox line in ${a.configFile}`
          : `sandbox: could not take windows.sandbox out of ${a.configFile}: ${WHY[outcome]}`
    )
  } catch (e) {
    a.log(`sandbox: could not take windows.sandbox out of ${a.configFile}: ${String(e)}`)
  }
  return r
}
