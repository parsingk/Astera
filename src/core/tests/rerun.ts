// What a rerun of only a configuration's failures adds to its command (Phase 3 Part 2, design §5 Part 2 item 5). Main
// computes it from the stored result and configuration, never from text the renderer sends. It narrows where the
// framework takes a filter: pytest by node ids, Vitest (a `vitest-json` report) by its failing files and their full
// names. Measured 2026-11-26: npm needs `--` before a script's arguments, pnpm 9 forwards a `--` literally (so none is
// added), yarn 1 forwards with or without it (yarn 4 could not be measured; it forwards what follows a script's name);
// bun was not measured (not installed), so a bun script reruns whole. Anything else reruns whole, and says so.
import { quoteArg, type RunContext } from '../run/build'
import type { RunConfig } from '../run/types'
import type { TestCase, TestRunResult } from './model'

export interface RerunPlan {
  /** Text added after the configuration's built command; empty for a whole rerun. */
  append: string
  scope: 'failures' | 'files' | 'all'
  why?: 'not-narrowable' | 'package-manager' | 'unsafe-names'
}

/** A character a shell may read as its own inside quotes (cmd's `%` and `!`), a quote, or a control character: a name
 *  carrying one is not handed to a shell as a filter. */
const UNSAFE = /[\p{Cc}"%!]/u

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

const whole = (why: NonNullable<RerunPlan['why']>): RerunPlan => ({ append: '', scope: 'all', why })

export function rerunArgs(config: RunConfig, result: TestRunResult, ctx: Pick<RunContext, 'platform' | 'packageManager'>): RerunPlan {
  const failing = result.cases.filter((c) => c.status === 'failed' || c.status === 'errored')
  if (failing.length === 0) return whole('not-narrowable')
  const fileOf = (c: TestCase): string | undefined => c.file ?? c.failure?.file
  if (failing.some((c) => fileOf(c) === undefined)) return whole('not-narrowable')
  const q = (v: string): string => quoteArg(v, ctx.platform)
  const files = [...new Set(failing.map((c) => fileOf(c) as string))]
  if (files.some((f) => UNSAFE.test(f))) return whole('unsafe-names')
  const onlyFiles = (prefix: string): RerunPlan => ({ append: prefix + files.map(q).join(' '), scope: 'files', why: 'unsafe-names' })

  if (config.type === 'pytest') {
    // A target already names what runs: an added node id would run beside it
    if (config.target) return whole('not-narrowable')
    const nodes = failing.map((c) => {
      const file = fileOf(c) as string
      const module = file.replace(/\.py$/, '').split('/').join('.')
      const cls = c.suite[0] ?? ''
      const classes = cls.startsWith(`${module}.`) ? cls.slice(module.length + 1).split('.') : []
      return [file, ...classes, c.name].join('::')
    })
    if (nodes.some((n) => UNSAFE.test(n))) return onlyFiles(' ')
    return { append: ` ${[...new Set(nodes)].map(q).join(' ')}`, scope: 'failures' }
  }

  if (result.format !== 'vitest-json' || (config.type !== 'node' && config.type !== 'shell' && config.type !== 'npm')) return whole('not-narrowable')
  let prefix = ' '
  if (config.type === 'npm') {
    const pm = config.packageManager && config.packageManager !== 'auto' ? config.packageManager : ctx.packageManager
    if (pm === 'bun') return whole('package-manager')
    if (pm === 'npm') prefix = ' -- '
  }
  const names = failing.map((c) => [...c.suite, c.name].join(' '))
  if (names.some((n) => UNSAFE.test(n))) return onlyFiles(prefix)
  const pattern = [...new Set(names)].map(escapeRegex).join('|')
  return { append: prefix + [...files.map(q), '-t', q(pattern)].join(' '), scope: 'failures' }
}
