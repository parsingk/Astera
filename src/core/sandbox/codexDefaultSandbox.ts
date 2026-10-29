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
// (startWarnings.ts). So does Codex's older feature key `[features] elevated_windows_sandbox = true`, which Codex 0.160
// still takes as the elevated default when no line is set (fix round 1, review I2): it is read, said and removed with
// the line. Only the account's own config.toml is read: a project's `.codex/config.toml` or a Codex profile is not.
//
// The file is the person's: it is edited as codexTrust.ts edits it, line by line with nothing parsed and re-serialised,
// one change at a time per file, through a temp file, with a .bak beside it, and through a link to the file it points
// to (fileQueue.ts writeTarget). Main and the Host only: this reads files.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { togglesMultiline } from '../accounts/codexTrust'
import { oneAtATime, writeTarget, writeThroughTmp } from '../accounts/fileQueue'
import { readStoreFile } from '../storeFile'

/** The elevated default a config.toml sets, read with Codex's own precedence (core/src/windows_sandbox.rs:83-88 at
 *  rust-v0.160.0: `windows.sandbox` first, then the older feature keys):
 *  - `set`: the top-level `windows.sandbox` and its value, with whether this module can take it out exactly
 *    (`editable`: a string value on a line of its own); `table`: a `[windows]` table is there;
 *  - `legacy` (fix round 1, review I2): no `windows.sandbox`, and Codex's older `elevated_windows_sandbox = true` in the
 *    top-level features (core/src/windows_sandbox.rs:97-106), which Codex 0.160 still takes as the elevated default and
 *    which its CLI setup does not clear (only the TUI's and app-server's setup do, `clear_legacy_windows_sandbox_keys`,
 *    :348-349); `editable` as for `set`;
 *  - `none`: neither (`table` as for `set`);
 *  - `unknown`: the file cannot be read with confidence: the scan ends inside a multi-line string (fix round 1, review
 *    M1), so which lines are keys cannot be told, and nothing is said to be set or taken out. */
export type WindowsSandboxDefault =
  | { kind: 'none'; table: boolean }
  | { kind: 'set'; value: string; editable: boolean; table: boolean }
  | { kind: 'legacy'; editable: boolean; table: boolean }
  | { kind: 'unknown' }

/** Whether a reading makes the elevated sandbox the home's default. */
export const isElevatedDefault = (d: WindowsSandboxDefault): boolean => (d.kind === 'set' && d.value === 'elevated') || d.kind === 'legacy'

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
// Codex's older feature key, a boolean (FeaturesToml's flattened `entries`, features/src/lib.rs at rust-v0.160.0)
const FEATURES_HEADER = /^\s*\[\s*(?:features|"features"|'features')\s*\]\s*(?:#.*)?$/
const BARE_FEATURES_HEADER = /^\s*\[\s*(?:features|"features"|'features')\s*\]\s*$/
const LEGACY_KEY = /^\s*(?:elevated_windows_sandbox|"elevated_windows_sandbox"|'elevated_windows_sandbox')\s*=(.*)$/
const DOTTED_LEGACY = /^\s*(?:features|"features"|'features')\s*\.\s*(?:elevated_windows_sandbox|"elevated_windows_sandbox"|'elevated_windows_sandbox')\s*=(.*)$/
const INLINE_FEATURES = /^\s*(?:features|"features"|'features')\s*=\s*\{(.*)\}\s*(?:#.*)?$/
const INLINE_LEGACY = /(?:^|[{,\s])(?:elevated_windows_sandbox|"elevated_windows_sandbox"|'elevated_windows_sandbox')\s*=\s*true\b/
const TRUE_VALUE = /^\s*true\s*(?:#.*)?$/

const valueOf = (rhs: string): { value: string; editable: boolean } => {
  const m = STRING_VALUE.exec(rhs)
  return m ? { value: m[1] ?? m[2], editable: true } : { value: rhs.trim(), editable: false }
}

/** A key's line, its form, its value and whether it can be taken out exactly. */
interface Found {
  line: number
  form: 'table' | 'dotted' | 'inline'
  value: string
  editable: boolean
}

/** A table's header line (null: none) and its end, the line after its last. */
interface Table {
  header: number | null
  end: number
}

/** What the scan found: `windows.sandbox`, the older feature key when it is true, their tables, and whether the scan
 *  ended inside a multi-line string. */
interface Located {
  unknown: boolean
  sandbox: Found | null
  legacy: Found | null
  windows: Table
  features: Table
}

function locate(lines: Line[]): Located {
  let multiline: '"""' | "'''" | null = null
  let where: 'root' | 'windows' | 'features' | 'other' = 'root'
  const windows: Table = { header: null, end: lines.length }
  const features: Table = { header: null, end: lines.length }
  let sandbox: Found | null = null
  let legacy: Found | null = null
  for (let i = 0; i < lines.length; i++) {
    const text = bare(lines, i)
    if (multiline === null) {
      if (ANY_HEADER.test(text)) {
        if (where === 'windows') windows.end = i
        if (where === 'features') features.end = i
        // The first of each only (a second is not TOML), never an array of tables
        const array = text.trimStart().startsWith('[[')
        if (!array && windows.header === null && WINDOWS_HEADER.test(text)) {
          windows.header = i
          where = 'windows'
        } else if (!array && features.header === null && FEATURES_HEADER.test(text)) {
          features.header = i
          where = 'features'
        } else where = 'other'
      } else if (where === 'root') {
        if (sandbox === null) {
          const dotted = DOTTED_KEY.exec(text)
          const inline = dotted ? null : INLINE_TABLE.exec(text)
          const s = inline ? INLINE_SANDBOX.exec(inline[1]) : null
          if (dotted) sandbox = { line: i, form: 'dotted', ...valueOf(dotted[1]) }
          else if (s) sandbox = { line: i, form: 'inline', value: s[1] ?? s[2], editable: false }
        }
        if (legacy === null) {
          const dotted = DOTTED_LEGACY.exec(text)
          const inline = dotted ? null : INLINE_FEATURES.exec(text)
          if (dotted && TRUE_VALUE.test(dotted[1])) legacy = { line: i, form: 'dotted', value: 'true', editable: true }
          else if (inline && INLINE_LEGACY.test(inline[1])) legacy = { line: i, form: 'inline', value: 'true', editable: false }
        }
      } else if (where === 'windows' && sandbox === null) {
        const key = SANDBOX_KEY.exec(text)
        if (key) sandbox = { line: i, form: 'table', ...valueOf(key[1]) }
      } else if (where === 'features' && legacy === null) {
        const key = LEGACY_KEY.exec(text)
        if (key && TRUE_VALUE.test(key[1])) legacy = { line: i, form: 'table', value: 'true', editable: true }
      }
    }
    multiline = togglesMultiline(text, multiline)
  }
  return { unknown: multiline !== null, sandbox, legacy, windows, features }
}

function settingOf(at: Located): WindowsSandboxDefault {
  if (at.unknown) return { kind: 'unknown' }
  const table = at.windows.header !== null
  if (at.sandbox) return { kind: 'set', value: at.sandbox.value, editable: at.sandbox.editable, table }
  if (at.legacy) return { kind: 'legacy', editable: at.legacy.editable, table }
  return { kind: 'none', table }
}

/** The elevated default a config.toml sets (WindowsSandboxDefault). Only the top-level keys: a profile's, or a key of
 *  that name in another table, is not the home's default, and text inside a multi-line string is not a key. A file that
 *  ends inside a multi-line string reads as `unknown`. */
export function windowsSandboxDefaultOf(text: string): WindowsSandboxDefault {
  return settingOf(locate(linesOf(text)))
}

/**
 * `text` without what makes the elevated sandbox its default, everything else as it was: the `windows.sandbox =
 * "elevated"` line, and Codex's older `elevated_windows_sandbox = true` (which Codex falls back to without the line, so
 * both go when both are there). Null when there is nothing this may take out exactly: no elevated default, another
 * value, an inline `windows = { … }` or `features = { … }` table, a file it cannot read with confidence. With
 * `dropEmptyTable`, a `[windows]` or `[features]` header left with nothing under it goes too, with the blank line before
 * it when nothing follows: what Codex appends to a file that had no such table (a blank line, the header, the key) then
 * comes back out whole. A header that carries a comment stays.
 */
export function withoutElevatedDefault(text: string, opts: { dropEmptyTable: boolean }): string | null {
  const lines = linesOf(text)
  const at = locate(lines)
  if (!isElevatedDefault(settingOf(at))) return null
  const taken = [at.sandbox, at.legacy].filter((f): f is Found => f !== null)
  if (taken.some((f) => !f.editable)) return null
  const drop = new Set<number>(taken.map((f) => f.line))
  if (opts.dropEmptyTable) {
    const tables = [
      { table: at.windows, bareHeader: BARE_WINDOWS_HEADER, used: at.sandbox?.form === 'table' },
      { table: at.features, bareHeader: BARE_FEATURES_HEADER, used: at.legacy?.form === 'table' }
    ]
      .filter((t) => t.used && t.table.header !== null)
      // The later table first, so the one before it sees what follows it as gone
      .sort((x, y) => (y.table.header ?? 0) - (x.table.header ?? 0))
    for (const { table, bareHeader } of tables) {
      const header = table.header as number
      if (!bareHeader.test(bare(lines, header))) continue
      const rest: number[] = []
      for (let i = header + 1; i < table.end; i++) if (!drop.has(i)) rest.push(i)
      if (!rest.every((i) => lines[i].text.trim() === '')) continue
      drop.add(header)
      for (const i of rest) drop.add(i)
      const follows = lines.some((l, i) => i >= table.end && !drop.has(i) && (l.text !== '' || l.end !== ''))
      if (!follows && header > 0 && bare(lines, header - 1).trim() === '') drop.add(header - 1)
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
 *  included, which removeElevatedDefault cannot take out), Codex's older feature key included. One that is not there, cannot be read, or cannot be read with
 *  confidence (`unknown`) does not: this is a hint, never a gate. */
export async function elevatedDefaultIn(file: string): Promise<boolean> {
  const read = await readStoreFile(file)
  if (read.kind !== 'text') return false
  return isElevatedDefault(windowsSandboxDefaultOf(read.text))
}

/** What removeElevatedDefault did: took the line out, found none, found another value (left), or found one it cannot
 *  take out exactly (left: an inline table, or a file it cannot read with confidence). */
export type RemoveOutcome = 'removed' | 'absent' | 'other-value' | 'cannot-edit'

/** Takes the elevated default out of the config.toml at `file` (withoutElevatedDefault), as
 *  markCodexProjectTrusted writes that file: one change at a time per file, the old one kept as .bak, the new one through
 *  a temp file and a rename. Writes nothing when there is nothing it may take out. Rejects when the file cannot be read
 *  or written. */
export async function removeElevatedDefault(file: string, opts: { dropEmptyTable: boolean }): Promise<RemoveOutcome> {
  return (await removeFrom(file, opts)).outcome
}

/** removeElevatedDefault's outcome, and for `cannot-edit` why: the file could not be read with confidence (`unknown`),
 *  or it is a link that points nowhere (`link`). A link that resolves is read and written through (fileQueue.ts
 *  writeTarget, fix round 1, review M3), so it stays a link and the change lands where Codex writes. */
async function removeFrom(file: string, opts: { dropEmptyTable: boolean }): Promise<{ outcome: RemoveOutcome; unknown: boolean; link: boolean }> {
  let outcome: RemoveOutcome = 'absent'
  let unknown = false
  let link = false
  await oneAtATime(file, async () => {
    const target = await writeTarget(file)
    if (target === null) {
      outcome = 'cannot-edit'
      link = true
      return
    }
    const read = await readStoreFile(target)
    if (read.kind === 'unreadable') throw read.error
    if (read.kind === 'missing') return
    const d = windowsSandboxDefaultOf(read.text)
    if (d.kind === 'none') return
    if (d.kind === 'unknown') {
      outcome = 'cannot-edit'
      unknown = true
      return
    }
    if (!isElevatedDefault(d)) {
      outcome = 'other-value'
      return
    }
    const next = withoutElevatedDefault(read.text, opts)
    if (next === null) {
      outcome = 'cannot-edit'
      return
    }
    await fs.copyFile(target, file + '.bak').catch(() => {})
    await writeThroughTmp(target, next)
    outcome = 'removed'
  })
  return { outcome, unknown, link }
}

/** A config.toml that is a link pointing nowhere, or that cannot be looked at: written by nobody here. */
const LINK_UNRESOLVED = 'it is a link that points nowhere, or cannot be looked at, so nothing is written'

/** Why a removal after a setup took nothing out, for its log line. */
const whyNot = (outcome: 'other-value' | 'cannot-edit', unknown: boolean, link: boolean): string =>
  link
    ? LINK_UNRESOLVED
    : unknown
      ? 'the file cannot be read with confidence (a multi-line string runs to its end as this reads it), so nothing is written'
      : outcome === 'other-value'
        ? 'it names another sandbox now, which is left as it is'
        : 'it is not on a line of its own (an inline table), so it is left; Settings › Agent profiles names it'

/** What putBack did: wrote the person's line back, found their value still there, found the line gone, or could not
 *  write it back exactly (`why`). */
type PutBack = { outcome: 'restored' } | { outcome: 'unchanged' } | { outcome: 'absent' } | { outcome: 'cannot-edit'; why: string }

/**
 * Puts the person's own `windows.sandbox` line back after a setup (fix round 1, review I1). Codex's setup overwrites
 * the key's value with "elevated" in place, keeping the line's decoration (core/src/config/edit.rs SetPath and
 * preserve_decor at rust-v0.160.0), so the located line, in the same form (the `[windows]` table, or dotted at the
 * root), gets the before-snapshot's line text back whole: value, quotes, spacing and comment. Only when that line now
 * reads "elevated": any other value is someone's later change, and is left. Written as removeFrom writes.
 */
async function putBack(file: string, before: { text: string; form: Found['form']; value: string }): Promise<PutBack> {
  let result: PutBack = { outcome: 'absent' }
  await oneAtATime(file, async () => {
    const target = await writeTarget(file)
    if (target === null) {
      result = { outcome: 'cannot-edit', why: LINK_UNRESOLVED }
      return
    }
    const read = await readStoreFile(target)
    if (read.kind === 'unreadable') throw read.error
    if (read.kind === 'missing') return
    const lines = linesOf(read.text)
    const at = locate(lines)
    if (at.unknown) {
      result = { outcome: 'cannot-edit', why: 'the file cannot be read with confidence (a multi-line string runs to its end as this reads it)' }
      return
    }
    const now = at.sandbox
    if (now === null) return
    if (now.value === before.value) {
      result = { outcome: 'unchanged' }
      return
    }
    if (now.form !== before.form || !now.editable || now.value !== 'elevated') {
      result = { outcome: 'cannot-edit', why: `the line is not where it was, or reads "${now.value}" now` }
      return
    }
    lines[now.line] = { text: (now.line === 0 && lines[0].text.startsWith(BOM) ? BOM : '') + before.text, end: lines[now.line].end }
    await fs.copyFile(target, file + '.bak').catch(() => {})
    await writeThroughTmp(target, lines.map((l) => l.text + l.end).join(''))
    result = { outcome: 'restored' }
  })
  return result
}

/**
 * Codex's setup of one home (`setUp`, windowsReadiness.ts codexWindowsSetup) for Astera's sandboxed sessions only. The
 * file is read first, and after a setup that worked:
 * - a home with no default before: the `windows.sandbox = "elevated"` line Codex added is taken back out
 *   (removeElevatedDefault; a `[windows]` table Codex made for it goes too);
 * - a home whose own line named another sandbox (say "unelevated"): Codex's setup overwrote it with "elevated", so the
 *   person's line is put back exactly as it was (putBack, fix round 1, review I1); one in an inline table cannot be, and
 *   is left and said;
 * - a home that already made the elevated sandbox its default, through the line or Codex's older feature key, is left:
 *   whose it is cannot be told (Settings › Agent profiles asks);
 * - and so is one that could not be read, or read with confidence, before.
 * Each way is logged. The setup's own answer is returned as it was: nothing here fails it. Never rejects.
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
  const beforeLines = before.kind === 'text' ? linesOf(before.text) : []
  const beforeAt = locate(beforeLines)
  const was = before.kind === 'text' ? settingOf(beforeAt) : ({ kind: 'none', table: false } as const)
  if (was.kind === 'unknown') {
    a.log(
      `sandbox: ${a.configFile} cannot be read with confidence before the setup (a multi-line string runs to its end as this reads it), so the line Codex added is left for Settings › Agent profiles`
    )
    return r
  }
  if (was.kind === 'legacy') {
    a.log(
      `sandbox: ${a.configFile} already made the elevated sandbox its default before the setup, through Codex's older [features] elevated_windows_sandbox = true, so the file is left as it is`
    )
    return r
  }
  if (was.kind === 'set' && was.value === 'elevated') {
    a.log(`sandbox: ${a.configFile} already set windows.sandbox = "elevated" before the setup, so the line is left as it is`)
    return r
  }
  if (was.kind === 'set') {
    const own = beforeAt.sandbox as Found
    if (own.form === 'inline' || !own.editable) {
      a.log(
        `sandbox: could not put back windows.sandbox = "${was.value}" in ${a.configFile}: it was in an inline table or not a plain string, which this does not write back, so what Codex's setup left there stays; Settings › Agent profiles names it if it reads "elevated"`
      )
      return r
    }
    try {
      const done = await putBack(a.configFile, { text: bare(beforeLines, own.line), form: own.form, value: was.value })
      a.log(
        done.outcome === 'restored'
          ? `sandbox: put back windows.sandbox = "${was.value}" in ${a.configFile}, the line as it was before the setup, which had written "elevated" over it`
          : done.outcome === 'unchanged'
            ? `sandbox: ${a.configFile} still says windows.sandbox = "${was.value}" after the setup, so there is nothing to put back`
            : done.outcome === 'absent'
              ? `sandbox: could not put back windows.sandbox = "${was.value}" in ${a.configFile}: no top-level windows.sandbox line was found there after the setup`
              : `sandbox: could not put back windows.sandbox = "${was.value}" in ${a.configFile}: ${done.why}, so nothing is written`
      )
    } catch (e) {
      a.log(`sandbox: could not put back windows.sandbox = "${was.value}" in ${a.configFile}: ${String(e)}`)
    }
    return r
  }
  try {
    const { outcome, unknown, link } = await removeFrom(a.configFile, { dropEmptyTable: !was.table })
    a.log(
      outcome === 'removed'
        ? `sandbox: took the windows.sandbox = "elevated" line Codex's setup added out of ${a.configFile}, so only sandboxed sessions run in the elevated sandbox`
        : outcome === 'absent'
          ? `sandbox: no top-level windows.sandbox line was found in ${a.configFile} after the setup, so nothing was taken out`
          : `sandbox: could not take windows.sandbox out of ${a.configFile}: ${whyNot(outcome, unknown, link)}`
    )
  } catch (e) {
    a.log(`sandbox: could not take windows.sandbox out of ${a.configFile}: ${String(e)}`)
  }
  return r
}
