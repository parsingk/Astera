// Why a check failed, decided by rules and nothing else (GitHub lifecycle design L8, §4.5), and the line that decided it.
// In order: a conclusion that says it; a workflow that ran no job; a cause outside the code (the runner, the network,
// permissions, the workflow file, a timeout), so a test run killed by a lost runner reads as infrastructure, and as
// environment when the step was the toolchain's setup; a cause inside the code; the failing step's command, or with no
// step the check's name; unknown. Rules read one line at a time, never npm's echo of a script or a group header, so a
// tool's name in a command is not that tool's output (G2 final review I3). Pure.
import type { CiFailureClass, GitHubCiConclusion } from './lifecycle'

export interface FailureInput {
  conclusion?: GitHubCiConclusion
  /** The failing step's command, as `##[group]Run <command>` names it. */
  step?: string
  /** The check's name: what ran, when there is no step to go by (a commit status, a log not read). */
  name?: string
  /** An Actions workflow that failed before any job started (its file could not run): there is no log to read. */
  ranNoJob?: boolean
  /** The failing step's output (evidence.ts excerptFromJobLog), its header block left out. */
  output: string
  /** The failure annotations' messages, the runner's boilerplate left out: the runner's own words can name the cause. */
  annotationMessages: string[]
}

export interface Classified {
  class: CiFailureClass
  /** One line that says why. */
  cause: string
}

interface Rule {
  class: CiFailureClass
  re: RegExp
  /** A line this matches is not the rule's cause. */
  unless?: RegExp
}

const BY_CONCLUSION: Partial<Record<GitHubCiConclusion, CiFailureClass>> = {
  'startup-failure': 'infrastructure',
  'timed-out': 'timeout',
  cancelled: 'cancelled',
  'action-required': 'permission'
}

/** This machine: a server the tests started here is the code under test, not the network (G2 final review I2). */
const LOOPBACK = /\b127\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\blocalhost\b|\b0\.0\.0\.0\b|(^|[^:\w])::1\b/i

const OUTSIDE: Rule[] = [
  {
    class: 'infrastructure',
    re: /runner has received a shutdown signal|lost communication with the server|hosted runner encountered an error|no space left on device/i
  },
  {
    class: 'infrastructure',
    re: /could not resolve host|getaddrinfo (ENOTFOUND|EAI_AGAIN)|\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|\b50[234]\b.*(bad gateway|service unavailable|gateway time-?out)|npm (ERR!|error) network/i,
    unless: LOOPBACK
  },
  { class: 'permission', re: /resource not accessible by integration|\(HTTP 403\)|403 forbidden|permission denied \(publickey\)|bad credentials|insufficient (permissions|scope)/i },
  { class: 'configuration', re: /invalid workflow file|the workflow is not valid|unrecognized named-value|required property is missing/i },
  { class: 'timeout', re: /exceeded the maximum execution time|has timed out|timed out after \d+/i }
]

/** A tool's own output, never its name: eslint's rows and total, ruff's rows, clippy's help link, prettier's check. */
const INSIDE: Rule[] = [
  { class: 'typecheck', re: /error TS\d{4}:|Found \d+ errors? in \d+ files?|^\S+\.py:\d+: error: / },
  {
    class: 'lint',
    re: /✖ \d+ problems? \(|\d+ problems? \(\d+ errors?|^\d+:\d+\s+error\s+\S|^\S+\.py:\d+:\d+: [A-Z]+\d+ |rust-lang\.github\.io\/rust-clippy|\bclippy::\w|Code style issues found/i
  },
  {
    class: 'test',
    re: /^not ok \d+|^# fail [1-9]|\bTests?:?\s+[1-9]\d* failed|\b[1-9]\d* (failed|failing)\b|AssertionError|--- FAIL:|^FAILED \S+::|test result: FAILED|^FAIL\s+\S+\.(test|spec)\./i
  },
  { class: 'build', re: /error\[E\d{4}\]|BUILD FAILED|build failed|ERROR in |could not compile|compilation failed|✘ \[ERROR\]/i }
]

const SETUP_STEP = /^actions\/(setup-|cache)|^(sudo )?(apt(-get)?|brew|choco) /i

const STEP: [CiFailureClass, RegExp][] = [
  ['lint', /\blint\b|eslint|ruff|clippy|biome|stylelint/i],
  ['typecheck', /typecheck|type-check|\btsc\b|mypy|pyright/i],
  ['test', /\btest\b|vitest|jest|pytest|go test|cargo test|mocha/i],
  ['build', /\bbuild\b|compile|webpack|gradle|\bmvn\b|\bmake\b/i]
]

const RUNNER_PREFIX = /^##\[(error|warning|notice)\]/
/** The runner's exit line: every failed step ends with it, and it says nothing about why. */
const EXIT_LINE =/^Process completed with exit code \d+\.?$/i

/** The lines rules may read: no blank line, no group header or end, no npm echo of a script (`> eslint .`); the
 *  runner's prefix taken off, since a problem matcher puts it on a tool's own line. */
function readable(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('##[group]') && !l.startsWith('##[endgroup]') && !l.startsWith('> '))
    .map((l) => l.replace(RUNNER_PREFIX, '').trim())
    .filter((l) => l !== '')
}

export function classifyCiFailure(i: FailureInput): Classified {
  const lines = [...readable(i.output), ...i.annotationMessages.flatMap(readable)]
  const lineOf = (rules: Rule[]): { class: CiFailureClass; cause: string } | undefined => {
    for (const r of rules) {
      const line = lines.find((l) => r.re.test(l) && !r.unless?.test(l))
      if (line !== undefined) return { class: r.class, cause: line }
    }
    return undefined
  }
  const fallback = (): string => {
    const annotation = i.annotationMessages.flatMap(readable)[0]
    if (annotation !== undefined) return annotation
    return readable(i.output).filter((l) => !EXIT_LINE.test(l)).at(-1) ?? i.conclusion ?? 'failure'
  }
  const byConclusion = i.conclusion ? BY_CONCLUSION[i.conclusion] : undefined
  if (byConclusion) return { class: byConclusion, cause: lineOf(OUTSIDE.filter((r) => r.class === byConclusion))?.cause ?? fallback() }
  if (i.ranNoJob) return { class: 'configuration', cause: 'the workflow file could not run: no job started' }
  const outside = lineOf(OUTSIDE)
  if (outside) return outside.class === 'infrastructure' && i.step && SETUP_STEP.test(i.step) ? { ...outside, class: 'environment' } : outside
  const inside = lineOf(INSIDE)
  if (inside) return inside
  // The name stands in for the step only when there is none: a failed setup step in a job named test is not a test.
  const what = i.step ?? i.name
  const byWhat = what === undefined ? undefined : STEP.find(([, re]) => re.test(what))
  return { class: byWhat ? byWhat[0] : 'unknown', cause: fallback() }
}
