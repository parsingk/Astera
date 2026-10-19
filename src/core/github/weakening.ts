// What in a pull request's diff can make its checks pass without the work being right (GitHub lifecycle G5a, design
// §7.4, S9): skip and only markers added, failures ignored in scripts and workflows, tests deleted, coverage thresholds
// lowered, workflow triggers removed or jobs turned off, test, lint and typecheck steps removed. These are findings for
// the review before merge-ready to judge against the objective, not failures: they are matched by their text, and a
// skip the objective asks for is right. Pure.
import { sanitize } from '../orchestration/checkpoint'

export interface DiffLine {
  /** The line's number in the new file for an added line, in the old file for a removed one. */
  line: number
  text: string
}

export interface DiffFile {
  /** The path after the change (the old one for a deleted file). */
  path: string
  deleted: boolean
  renamed: boolean
  newFile: boolean
  added: DiffLine[]
  removed: DiffLine[]
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

/** A path as git prints it: C-quoted when it holds a quote, a backslash or a control character (octal bytes for the
 *  rest), and without its prefix (`a/`, `b/`). */
function diffPath(raw: string, prefix: string): string {
  let s = raw.endsWith('\t') ? raw.slice(0, -1) : raw
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    const bytes: number[] = []
    for (let i = 1; i < s.length - 1; i++) {
      const ch = s[i]
      if (ch !== '\\') {
        bytes.push(...Buffer.from(ch, 'utf8'))
        continue
      }
      const next = s[i + 1]
      if (/[0-7]/.test(next)) {
        bytes.push(parseInt(s.slice(i + 1, i + 4), 8))
        i += 3
      } else {
        bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0))
        i += 1
      }
    }
    s = Buffer.from(bytes).toString('utf8')
  }
  return s.startsWith(prefix) ? s.slice(prefix.length) : s
}

/** The header's guess at the path, for a file with no ---/+++ lines (a binary or a mode change): `a/P b/P`. */
function headerPath(rest: string): string {
  const half = (rest.length - 1) / 2
  if (Number.isInteger(half) && rest.startsWith('a/') && rest.slice(half + 1).startsWith('b/') && rest.slice(2, half) === rest.slice(half + 3))
    return rest.slice(half + 3)
  const at = rest.lastIndexOf(' b/')
  return at >= 0 ? rest.slice(at + 3) : rest
}

/** A unified diff (`git diff`, with a/ and b/ prefixes) as files with their added and removed lines. The path comes
 *  from the +++ line (the --- line for a deleted file, `rename to` for a pure rename). A line inside a hunk is content
 *  whatever it starts with after its +, - or space; an empty one is context (diff.suppressBlankEmpty). */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let cur: DiffFile | undefined
  let minus: string | undefined
  let inHunk = false
  let oldNo = 0
  let newNo = 0
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith('diff --git ')) {
      cur = { path: headerPath(raw.slice('diff --git '.length)), deleted: false, renamed: false, newFile: false, added: [], removed: [] }
      files.push(cur)
      minus = undefined
      inHunk = false
      continue
    }
    if (!cur) continue
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      inHunk = true
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      continue
    }
    if (!inHunk) {
      if (raw.startsWith('deleted file mode')) cur.deleted = true
      else if (raw.startsWith('new file mode')) cur.newFile = true
      else if (raw.startsWith('rename from ')) cur.renamed = true
      else if (raw.startsWith('rename to ')) {
        cur.renamed = true
        cur.path = diffPath(raw.slice('rename to '.length), '')
      } else if (raw.startsWith('--- ')) {
        minus = raw.slice(4) === '/dev/null' ? undefined : diffPath(raw.slice(4), 'a/')
      } else if (raw.startsWith('+++ ')) {
        const plus = raw.slice(4)
        if (plus !== '/dev/null') cur.path = diffPath(plus, 'b/')
        else if (minus !== undefined) cur.path = minus
      }
      continue
    }
    if (raw.startsWith('+')) cur.added.push({ line: newNo++, text: raw.slice(1) })
    else if (raw.startsWith('-')) cur.removed.push({ line: oldNo++, text: raw.slice(1) })
    else if (raw.startsWith(' ') || raw === '') {
      oldNo++
      newNo++
    }
  }
  return files
}

export type WeakeningKind =
  | 'skip-marker'
  | 'continue-on-error'
  | 'ignored-failure'
  | 'test-deleted'
  | 'coverage-lowered'
  | 'trigger-removed'
  | 'job-disabled'
  | 'check-step-removed'

export interface WeakeningFinding {
  kind: WeakeningKind
  /** The file's path, as `promptText` puts it. */
  file: string
  /** The added line's number in the new file; absent for what was removed or deleted. */
  line?: number
  /** The line, as `promptText` puts it. */
  text: string
}

export const WEAKENING_FINDINGS_MAX = 30
const PROMPT_TEXT_MAX = 200
/** A line longer than this is matched on its start: the patterns stay linear, and no real one needs more. */
const PROBE_MAX = 2000

/** Text an agent wrote, made fit to quote in a prompt: redacted, every control, format and separator character (C0,
 *  C1, bidi controls, line and paragraph separators) a space, spaces collapsed, cut to 200 characters. */
export function promptText(text: string, max = PROMPT_TEXT_MAX): string {
  return sanitize(text)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

const WORKFLOW = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/
const MAKEFILE = /(^|\/)(GNU)?[Mm]akefile$|\.mk$/
const SCRIPT = /(^|\/)package\.json$|\.(sh|bash|zsh|ps1|cmd|bat)$/
const PROSE = /\.(md|mdx|txt|rst|adoc)$/i
const VENDORED = /(^|\/)(vendor|node_modules|third_party|dist|build)\/|\.min\.[cm]?js$/
const TEST_PATH = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$|Tests?\.(java|kt|cs)$/
const COVERAGE_FILE = /(^|\/)(vitest|jest|karma)\.config\.[cm]?[jt]s$|(^|\/)\.nycrc|(^|\/)\.c8rc|(^|\/)package\.json$|(^|\/)pyproject\.toml$|(^|\/)setup\.cfg$|(^|\/)tox\.ini$|(^|\/)pytest\.ini$|(^|\/)\.coveragerc$/
const CODECOV_FILE = /(^|\/)\.?codecov\.ya?ml$/

/** Skip and only on a test call (not an iterator's or a query's `.skip(n)`), a test turned off for good, and each
 *  framework's own markers. */
const SKIP_MARKER = new RegExp(
  [
    String.raw`\b(it|test|describe|suite|context|bench|specify)(\.\w+)*\.(skip|only)\b`,
    String.raw`\.skipIf\s*\(\s*(true|!0)\s*\)`,
    String.raw`\.runIf\s*\(\s*(false|!1)\s*\)`,
    String.raw`\bx(it|describe|test)\s*\(`,
    String.raw`\bpytest\.skip\s*\(`,
    String.raw`@pytest\.mark\.(skip|xfail)\b`,
    String.raw`@unittest\.(skip|expectedFailure)\b`,
    String.raw`\.skipTest\s*\(`,
    String.raw`\bt\.Skip(Now|f)?\s*\(`,
    String.raw`@(Disabled|Ignore)\b`,
    String.raw`#\[ignore\]`
  ].join('|')
)
const CONTINUE_ON_ERROR = /\bcontinue-on-error\s*:\s*true\b/
const IGNORED = /\|\|\s*(true|:)(?![\w-])/
const EXIT_0 = /\bexit\s+0\b/
/** `|| true` after a command that only cleans up: not a failure ignored. */
const CLEANUP = /\b(rm|rmdir|mkdir|kill|pkill|killall|unlink)\b[^|]*\|\|\s*(true|:)|\bdocker\s+(rm|rmi|stop|kill)\b[^|]*\|\||\bgit\s+branch\s+-D\b[^|]*\|\|/
const MAKE_IGNORE = /^\t-\S/
const COVERAGE_VALUE = /(?:--cov-fail-under|(?<![\w-])(lines|branches|functions|statements|fail_under|fail-under))["']?(?:\s*[:=]\s*|\s+)(\d+(?:\.\d+)?)/
/** codecov's own: `target` lowered and `threshold` (the drop it allows) raised make it ask for less. */
const CODECOV_VALUE = /(?<![\w-])(target|threshold)["']?\s*:\s*(\d+(?:\.\d+)?)/
const TRIGGERS = ['pull_request', 'pull_request_target', 'push', 'merge_group', 'workflow_dispatch']
const TRIGGER_NAME = `(${TRIGGERS.join('|')})`
const ON_INLINE = /^\s*on\s*:\s*(\S.*)$/
const TRIGGER_KEY = new RegExp(String.raw`^\s*${TRIGGER_NAME}\s*:\s*(#.*)?$`)
const TRIGGER_ITEM = new RegExp(String.raw`^\s*-\s*${TRIGGER_NAME}\s*$`)
const JOB_DISABLED = /\bif\s*:\s*(false\b|\$\{\{\s*false\s*\}\})/
const CHECK_STEP = new RegExp(
  [
    String.raw`\b(eslint|lint|tsc|typecheck|type-check|mypy|ruff|clippy|biome|flake8|pylint|golangci-lint)\b`,
    String.raw`prettier\s+--check`,
    String.raw`\b(npm|yarn|pnpm|bun)\s+(run\s+)?test\b`,
    String.raw`\b(pytest|vitest|jest|mocha|tox|phpunit|rspec)\b`,
    String.raw`\b(go|cargo|dotnet|swift)\s+test\b`,
    String.raw`\bplaywright\s+test\b`,
    String.raw`\b(mvn|mvnw|gradle|gradlew)\b.*\btest\b`
  ].join('|'),
  'i'
)

const probe = (text: string): string => (text.length > PROBE_MAX ? text.slice(0, PROBE_MAX) : text)

/** A removed line whose text comes back among the added ones only moved. */
const movedIn = (f: DiffFile): ((l: DiffLine) => boolean) => {
  const added = new Set(f.added.map((a) => a.text.trim()))
  return (l) => added.has(l.text.trim())
}

/** The trigger names a workflow line declares: `on: push`, `on: [push, pull_request]`, a `push:` key that opens a block,
 *  a `- push` item. A `push: true` option of a step declares none. */
function triggerNamesOf(text: string): string[] {
  const t = probe(text)
  const inline = ON_INLINE.exec(t)
  if (inline) {
    const value = inline[1].replace(/#.*$/, '').trim()
    if (value === '' || value.startsWith('{')) return []
    return value
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((w) => w.trim().replace(/^['"]|['"]$/g, ''))
      .filter((w) => TRIGGERS.includes(w))
  }
  const key = TRIGGER_KEY.exec(t) ?? TRIGGER_ITEM.exec(t)
  return key ? [key[1]] : []
}

function coverageFindings(f: DiffFile, re: RegExp, weaker: (key: string, was: number, now: number) => boolean, removalWeakens: (key: string) => boolean): WeakeningFinding[] {
  const values = (lines: DiffLine[]) =>
    lines.flatMap((l) => {
      const m = re.exec(probe(l.text))
      return m ? [{ l, key: (m[1] ?? 'cov-fail-under').toLowerCase(), value: Number(m[2]) }] : []
    })
  const added = values(f.added)
  const seen = new Map<string, number>()
  return values(f.removed).flatMap((r) => {
    // The n-th removed value of a key pairs with the n-th added one of it
    const n = seen.get(r.key) ?? 0
    seen.set(r.key, n + 1)
    const now = added.filter((a) => a.key === r.key)[n]
    if (now) return weaker(r.key, r.value, now.value) ? [{ kind: 'coverage-lowered' as const, file: promptText(f.path), line: now.l.line, text: promptText(now.l.text) }] : []
    return removalWeakens(r.key) ? [{ kind: 'coverage-lowered' as const, file: promptText(f.path), text: promptText(r.l.text) }] : []
  })
}

function findingsOf(f: DiffFile): WeakeningFinding[] {
  const out: WeakeningFinding[] = []
  const file = promptText(f.path)
  const at = (kind: WeakeningKind, l: DiffLine, withLine: boolean): void => {
    out.push({ kind, file, ...(withLine ? { line: l.line } : {}), text: promptText(l.text) })
  }
  const workflow = WORKFLOW.test(f.path)
  const makefile = MAKEFILE.test(f.path)
  const scripted = workflow || makefile || SCRIPT.test(f.path)
  if (f.deleted && TEST_PATH.test(f.path)) out.push({ kind: 'test-deleted', file, text: file })
  for (const l of f.added) {
    const t = probe(l.text)
    if (!PROSE.test(f.path) && !VENDORED.test(f.path) && SKIP_MARKER.test(t)) at('skip-marker', l, true)
    if (workflow && CONTINUE_ON_ERROR.test(t)) at('continue-on-error', l, true)
    if (scripted && ((IGNORED.test(t) && !CLEANUP.test(t)) || (EXIT_0.test(t) && !f.newFile) || (makefile && MAKE_IGNORE.test(l.text))))
      at('ignored-failure', l, true)
    if (workflow && JOB_DISABLED.test(t)) at('job-disabled', l, true)
  }
  if (workflow) {
    const moved = movedIn(f)
    const kept = new Set(f.added.flatMap((l) => triggerNamesOf(l.text)))
    // A step whose tool still runs in an added line was changed, not removed
    const toolOf = (text: string): string | undefined => CHECK_STEP.exec(probe(text))?.[0].toLowerCase().replace(/\s+/g, ' ')
    const tools = new Set(f.added.map((l) => toolOf(l.text)).filter((t): t is string => t !== undefined))
    for (const l of f.removed) {
      const tool = toolOf(l.text)
      if (triggerNamesOf(l.text).some((name) => !kept.has(name))) at('trigger-removed', l, false)
      else if (!moved(l) && tool !== undefined && !tools.has(tool)) at('check-step-removed', l, false)
    }
  }
  if (workflow || COVERAGE_FILE.test(f.path)) out.push(...coverageFindings(f, COVERAGE_VALUE, (_k, was, now) => now < was, () => true))
  if (CODECOV_FILE.test(f.path))
    out.push(...coverageFindings(f, CODECOV_VALUE, (k, was, now) => (k === 'threshold' ? now > was : now < was), (k) => k === 'target'))
  return out
}

/** The findings of a whole pull request's diff, by file then line: the first WEAKENING_FINDINGS_MAX, and how many there
 *  were. */
export function weakeningFindings(diff: string): { findings: WeakeningFinding[]; total: number } {
  const all = parseUnifiedDiff(diff)
    .flatMap(findingsOf)
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.line ?? 0) - (b.line ?? 0)))
  return { findings: all.slice(0, WEAKENING_FINDINGS_MAX), total: all.length }
}
