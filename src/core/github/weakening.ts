// What in a pull request's diff can make its checks pass without the work being right (GitHub lifecycle G5a, design
// §7.4, S9): skip and only markers added, failures ignored in scripts and workflows, tests deleted, coverage thresholds
// lowered, workflow triggers removed or jobs turned off, lint and typecheck steps removed. These are findings for the
// review before merge-ready to judge against the objective, not failures: a skip the objective asks for is right. Pure.
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
  added: DiffLine[]
  removed: DiffLine[]
}

/** A unified diff (`git diff`) as files with their added and removed lines. A line inside a hunk is content whatever
 *  it starts with after its +, - or space. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let cur: DiffFile | undefined
  let inHunk = false
  let oldNo = 0
  let newNo = 0
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith('diff --git ')) {
      const at = raw.lastIndexOf(' b/')
      cur = { path: at >= 0 ? raw.slice(at + 3) : raw.slice('diff --git '.length), deleted: false, renamed: false, added: [], removed: [] }
      files.push(cur)
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
      else if (raw.startsWith('rename from ') || raw.startsWith('rename to ')) cur.renamed = true
      continue
    }
    if (raw.startsWith('+')) cur.added.push({ line: newNo++, text: raw.slice(1) })
    else if (raw.startsWith('-')) cur.removed.push({ line: oldNo++, text: raw.slice(1) })
    else if (raw.startsWith(' ')) {
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
  file: string
  /** The added line's number in the new file; absent for what was removed or deleted. */
  line?: number
  /** The line, redacted, on one line, at most FINDING_TEXT_MAX characters. */
  text: string
}

export const WEAKENING_FINDINGS_MAX = 30
const FINDING_TEXT_MAX = 200

const WORKFLOW = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/
const SCRIPT = /(^|\/)package\.json$|\.(sh|bash|zsh|ps1|cmd|bat)$|(^|\/)(GNU)?[Mm]akefile$|\.mk$/
const PROSE = /\.(md|mdx|txt|rst|adoc)$/i
const TEST_PATH = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$|Tests?\.(java|kt|cs)$/
const COVERAGE_FILE = /(^|\/)(vitest|jest|karma)\.config\.[cm]?[jt]s$|(^|\/)\.nycrc|(^|\/)\.c8rc|(^|\/)package\.json$|(^|\/)pyproject\.toml$|(^|\/)setup\.cfg$|(^|\/)tox\.ini$|(^|\/)pytest\.ini$|(^|\/)\.coveragerc$|(^|\/)\.?codecov\.ya?ml$/

const SKIP_MARKER = /\.(skip|only)\s*\(|\bx(it|describe)\s*\(|@pytest\.mark\.skip|@unittest\.skip|@Disabled\b|#\[ignore\]/
const CONTINUE_ON_ERROR = /\bcontinue-on-error\s*:\s*true\b/
const IGNORED_FAILURE = /\|\|\s*true\b|\bexit\s+0\b/
const COVERAGE_VALUE = /\b(lines|branches|functions|statements|fail_under|fail-under|threshold)\b["']?\s*[:=\s]\s*(\d+(?:\.\d+)?)/i
const TRIGGER = /^\s*(on\s*:|(pull_request(_target)?|push|merge_group|workflow_dispatch)\s*:|-\s*(pull_request(_target)?|push|merge_group)\s*$)/
const JOB_DISABLED = /\bif\s*:\s*(false\b|\$\{\{\s*false\s*\}\})/
const CHECK_STEP = /\b(eslint|lint|tsc|typecheck|type-check|mypy|ruff|clippy|biome|flake8|pylint|golangci-lint)\b|prettier\s+--check/i

/** One line for a prompt: redacted, control characters as spaces, cut. */
const shown = (text: string): string =>
  [...sanitize(text)]
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
    .join('')
    .trim()
    .slice(0, FINDING_TEXT_MAX)

/** A removed line whose text comes back among the added ones only moved. */
const movedIn = (f: DiffFile): ((l: DiffLine) => boolean) => {
  const added = new Set(f.added.map((a) => a.text.trim()))
  return (l) => added.has(l.text.trim())
}

function coverageFindings(f: DiffFile): WeakeningFinding[] {
  const values = (lines: DiffLine[]) =>
    lines.flatMap((l) => {
      const m = COVERAGE_VALUE.exec(l.text)
      return m ? [{ l, key: m[1].toLowerCase(), value: Number(m[2]) }] : []
    })
  const added = values(f.added)
  return values(f.removed).flatMap((r) => {
    const now = added.find((a) => a.key === r.key)
    if (now && now.value >= r.value) return []
    return [now ? { kind: 'coverage-lowered' as const, file: f.path, line: now.l.line, text: shown(now.l.text) } : { kind: 'coverage-lowered' as const, file: f.path, text: shown(r.l.text) }]
  })
}

function findingsOf(f: DiffFile): WeakeningFinding[] {
  const out: WeakeningFinding[] = []
  const at = (kind: WeakeningKind, l: DiffLine, withLine: boolean): void => {
    out.push({ kind, file: f.path, ...(withLine ? { line: l.line } : {}), text: shown(l.text) })
  }
  const workflow = WORKFLOW.test(f.path)
  const moved = movedIn(f)
  if (f.deleted && TEST_PATH.test(f.path)) out.push({ kind: 'test-deleted', file: f.path, text: f.path })
  for (const l of f.added) {
    if (!PROSE.test(f.path) && SKIP_MARKER.test(l.text)) at('skip-marker', l, true)
    if (workflow && CONTINUE_ON_ERROR.test(l.text)) at('continue-on-error', l, true)
    if ((workflow || SCRIPT.test(f.path)) && IGNORED_FAILURE.test(l.text)) at('ignored-failure', l, true)
    if (workflow && JOB_DISABLED.test(l.text)) at('job-disabled', l, true)
  }
  if (workflow)
    for (const l of f.removed.filter((r) => !moved(r))) {
      if (TRIGGER.test(l.text)) at('trigger-removed', l, false)
      else if (CHECK_STEP.test(l.text)) at('check-step-removed', l, false)
    }
  if (workflow || COVERAGE_FILE.test(f.path)) out.push(...coverageFindings(f))
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
