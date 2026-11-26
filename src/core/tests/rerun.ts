// What a rerun of only a configuration's failures adds to its command (Phase 3 Part 2, design §5 Part 2 item 5). Main
// computes it from the stored result and configuration, never from text the renderer sends. It narrows where the
// framework takes a filter: pytest by node ids, Vitest (a `vitest-json` report) by its failing files and their full
// names. Measured 2026-11-26: npm needs `--` before a script's arguments, pnpm 9 forwards a `--` literally (so none is
// added), yarn 1 forwards with or without it (yarn 4 could not be measured; it forwards what follows a script's name);
// bun was not measured (not installed), so a bun script reruns whole. On cmd, pnpm 9.15.9 doubles every backslash it
// forwards (pnpm 12.11.2, npm and yarn 1.22.22 pass it as it is), so a pnpm name filter that needs one runs by files
// there. Anything else reruns whole, and says so.
import { quoteArg, type RunContext } from '../run/build'
import type { RunConfig } from '../run/types'
import type { RerunScope, RerunWhy, TestCase, TestRunResult } from './model'

export interface RerunPlan {
  /** Text added after the configuration's built command; empty for a whole rerun. */
  append: string
  scope: RerunScope
  why?: RerunWhy
}

/** A character a shell may read as its own inside quotes (cmd's `%` and `!`, sh's `$` and backtick inside the double
 *  quotes pnpm 9 puts around what it forwards), a quote, or a control character: a name carrying one is not handed to
 *  a shell as a filter. */
const UNSAFE = /[\p{Cc}"%!$`]/u

/** A shell operator: text appended after it would reach the last command of a list or pipe, not the test runner. */
const OPERATOR = /[;&|<>]/

/** The longest text a rerun adds: cmd refuses a command line over 8191 characters, and Linux takes `sh -c`'s command as
 *  one argument of at most 128 KiB. Both leave room for the configuration's own command. */
const maxAppend = (platform: string): number => (platform === 'win32' ? 6000 : 100_000)

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

const whole = (why: NonNullable<RerunPlan['why']>): RerunPlan => ({ append: '', scope: 'all', why })

/** A narrowed plan, and what a rerun by the failing files alone adds when the plan is longer than a shell takes. */
type Narrowed = RerunPlan & { byFiles?: string }

export function rerunArgs(config: RunConfig, result: TestRunResult, ctx: Pick<RunContext, 'platform' | 'packageManager'>): RerunPlan {
  const { byFiles, ...plan } = narrow(config, result, ctx)
  const max = maxAppend(ctx.platform)
  if (plan.append.length <= max) return plan
  if (byFiles !== undefined && byFiles.length <= max) return { append: byFiles, scope: 'files', why: 'too-long' }
  return whole('too-long')
}

function narrow(config: RunConfig, result: TestRunResult, ctx: Pick<RunContext, 'platform' | 'packageManager'>): Narrowed {
  const failing = result.cases.filter((c) => c.status === 'failed' || c.status === 'errored')
  if (failing.length === 0) return whole('not-narrowable')
  const fileOf = (c: TestCase): string | undefined => c.file ?? c.failure?.file
  if (failing.some((c) => fileOf(c) === undefined)) return whole('not-narrowable')
  const q = (v: string): string => quoteArg(v, ctx.platform)
  const files = [...new Set(failing.map((c) => fileOf(c) as string))]
  if (files.some((f) => UNSAFE.test(f))) return whole('unsafe-names')
  const onlyFiles = (prefix: string, why: NonNullable<RerunPlan['why']>): Narrowed => ({ append: prefix + files.map(q).join(' '), scope: 'files', why })
  const fileLevel = failing.some((c) => c.fileLevel === true)

  if (config.type === 'pytest') {
    // A target already names what runs: an added node id would run beside it
    if (config.target) return whole('not-narrowable')
    if (fileLevel) return onlyFiles(' ', 'file-level')
    const nodes = failing.map((c) => {
      const file = fileOf(c) as string
      const module = file.replace(/\.py$/, '').split('/').join('.')
      const cls = c.suite[0] ?? ''
      const classes = cls.startsWith(`${module}.`) ? cls.slice(module.length + 1).split('.') : []
      return [file, ...classes, c.name].join('::')
    })
    if (nodes.some((n) => UNSAFE.test(n))) return onlyFiles(' ', 'unsafe-names')
    return { append: ` ${[...new Set(nodes)].map(q).join(' ')}`, scope: 'failures', byFiles: onlyFiles(' ', 'too-long').append }
  }

  if (result.format !== 'vitest-json' || (config.type !== 'node' && config.type !== 'shell' && config.type !== 'npm')) return whole('not-narrowable')
  if (config.type === 'shell' && OPERATOR.test(config.command)) return whole('not-narrowable')
  let prefix = ' '
  let pm: string | undefined
  if (config.type === 'npm') {
    pm = config.packageManager && config.packageManager !== 'auto' ? config.packageManager : ctx.packageManager
    if (pm === 'bun') return whole('package-manager')
    // A configuration whose own arguments already end npm's (`-- --reporter=json`) needs no second `--`
    if (pm === 'npm' && !(config.args ?? '').split(/\s+/).includes('--')) prefix = ' -- '
  }
  if (fileLevel) return onlyFiles(prefix, 'file-level')
  const names = failing.map((c) => [...c.suite, c.name].join(' '))
  if (names.some((n) => UNSAFE.test(n))) return onlyFiles(prefix, 'unsafe-names')
  const pattern = [...new Set(names)].map(escapeRegex).join('|')
  if (pm === 'pnpm' && ctx.platform === 'win32' && pattern.includes('\\')) return onlyFiles(prefix, 'package-manager')
  return { append: prefix + [...files.map(q), '-t', q(pattern)].join(' '), scope: 'failures', byFiles: onlyFiles(prefix, 'too-long').append }
}
