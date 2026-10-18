// Why a check failed, decided by rules and nothing else (GitHub lifecycle design L8, §4.5). In order: a conclusion that
// says it; a cause outside the code (the runner, the network, permissions, the workflow file, a timeout), so a test run
// killed by a lost runner reads as infrastructure; a failing setup step; a cause inside the code; the failing step's
// command; unknown. Pure.
import type { CiFailureClass, GitHubCiConclusion } from './lifecycle'

export interface FailureInput {
  conclusion?: GitHubCiConclusion
  /** The failing step's command, as `##[group]Run <command>` names it. */
  step?: string
  /** The failing step's lines (evidence.ts excerptFromJobLog). */
  excerpt: string
  /** Every annotation message, notices included: the runner's own words can name the cause. */
  annotationMessages: string[]
}

const BY_CONCLUSION: Partial<Record<GitHubCiConclusion, CiFailureClass>> = {
  'startup-failure': 'infrastructure',
  'timed-out': 'timeout',
  cancelled: 'cancelled',
  'action-required': 'permission'
}

const OUTSIDE: [CiFailureClass, RegExp][] = [
  [
    'infrastructure',
    /runner has received a shutdown signal|lost communication with the server|hosted runner encountered an error|no space left on device|could not resolve host|\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED)\b|socket hang up|\b50[234]\b.*(bad gateway|service unavailable|gateway time-?out)|npm (ERR!|error) network/i
  ],
  ['permission', /resource not accessible by integration|\(HTTP 403\)|403 forbidden|permission denied \(publickey\)|bad credentials|insufficient (permissions|scope)/i],
  ['configuration', /invalid workflow file|the workflow is not valid|unrecognized named-value|required property is missing/i],
  ['timeout', /exceeded the maximum execution time|has timed out|timed out after \d+/i]
]

const INSIDE: [CiFailureClass, RegExp][] = [
  ['typecheck', /error TS\d{4}:|Found \d+ errors? in \d+ files?|^\S+\.py:\d+: error: /im],
  ['lint', /✖ \d+ problems? \(|\d+ problems? \(\d+ errors?|\beslint\b|\bruff\b|\bclippy\b|stylelint|Code style issues found/i],
  ['test', /^not ok \d+|^# fail [1-9]|Tests?:\s+\d+ failed|\b\d+ (failed|failing)\b|AssertionError|--- FAIL:|^FAILED \S+::|test result: FAILED|^\s*FAIL\s+\S+\.(test|spec)\./im],
  ['build', /error\[E\d{4}\]|BUILD FAILED|build failed|ERROR in |could not compile|compilation failed|✘ \[ERROR\]/i]
]

const SETUP_STEP = /^actions\/(setup-|cache)|^(sudo )?(apt(-get)?|brew|choco) /i

const STEP: [CiFailureClass, RegExp][] = [
  ['lint', /\blint\b|eslint|ruff|clippy|biome|stylelint/i],
  ['typecheck', /typecheck|type-check|\btsc\b|mypy|pyright/i],
  ['test', /\btest\b|vitest|jest|pytest|go test|cargo test|mocha/i],
  ['build', /\bbuild\b|compile|webpack|gradle|\bmvn\b|\bmake\b/i]
]

export function classifyCiFailure(i: FailureInput): CiFailureClass {
  const byConclusion = i.conclusion ? BY_CONCLUSION[i.conclusion] : undefined
  if (byConclusion) return byConclusion
  const text = [i.excerpt, ...i.annotationMessages].join('\n')
  const outside = OUTSIDE.find(([, re]) => re.test(text))
  if (outside) return outside[0]
  if (i.step && SETUP_STEP.test(i.step)) return 'environment'
  const inside = INSIDE.find(([, re]) => re.test(text))
  if (inside) return inside[0]
  const step = i.step
  const byStep = step === undefined ? undefined : STEP.find(([, re]) => re.test(step))
  return byStep ? byStep[0] : 'unknown'
}

const RUNNER_LINE = /^##\[(error|warning|notice)\]/
/** The same rules, line by line: `m` is dropped since each test sees one line. */
const RECOGNISED = [...OUTSIDE, ...INSIDE].map(([, re]) => new RegExp(re.source, re.flags.replace('m', '')))

/** One line that says why: the first excerpt line a rule recognises; else the first annotation; else the excerpt's last
 *  line that is not the runner's own; else `fallback`. Without the runner's `##[error]` prefix. */
export function failureCause(excerpt: string, messages: string[], fallback: string): string {
  const lines = excerpt
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  const recognised = lines.find((l) => RECOGNISED.some((re) => re.test(l)))
  if (recognised) return recognised.replace(RUNNER_LINE, '').trim()
  if (messages.length > 0) return messages[0]
  const own = lines.filter((l) => !RUNNER_LINE.test(l))
  return own.at(-1) ?? fallback
}
