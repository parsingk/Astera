// What starting the Enforce hook costs (enforce and sandbox design §10.5, S1's review M6): the hook as the build bundles
// it, run as the CLIs run it, by node and by Electron as node.
import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import source from 'virtual:astera-enforce-hook'
import { STARTER_POLICY } from '../../src/core/audit/policy'
import { HOOK_POLICY, extractHookSource, measureHook, stats } from './latency.mjs'

describe('extractHookSource', () => {
  it('finds the hook in a chunk as the build writes it', () => {
    expect(extractHookSource(`x();const ENFORCE_HOOK_SOURCE = '"use strict";\\nconst a = 1;\\n';\nmore()`)).toBe('"use strict";\nconst a = 1;\n')
    expect(extractHookSource('const other = 1')).toBeNull()
  })
})

describe('stats', () => {
  it('takes the median and the 90th percentile', () => {
    expect(stats([5, 1, 3, 2, 4])).toEqual({ runs: 5, median: 3, p90: 5 })
    expect(stats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({ runs: 10, median: 5.5, p90: 9 })
    expect(stats([1.234, 1.236])).toEqual({ runs: 2, median: 1.2, p90: 1.2 })
  })
})

// Final review M7: the hook is timed with the Rules beside it, and only once it is shown to decide
describe('HOOK_POLICY', () => {
  it('is the starter Rules in enforce mode', () => {
    expect(HOOK_POLICY).toEqual({ ...STARTER_POLICY, mode: 'enforce' })
  })
})

describe('measureHook', () => {
  const node = [{ name: 'node', file: process.execPath, env: {} }]

  it('times the bundled hook with the Rules beside it, once it denied what the Rules deny', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'astera-latency-'))
    try {
      const hookFile = path.join(dir, 'astera-enforce-hook.cjs')
      writeFileSync(hookFile, source)
      const r = measureHook({ hookFile, runs: 3, interpreters: node })
      expect(r.node.runs).toBe(3)
      expect(r.node.median).toBeGreaterThan(0)
      expect(JSON.parse(readFileSync(path.join(dir, 'audit-policy.json'), 'utf8'))).toEqual(HOOK_POLICY)
      expect(existsSync(path.join(dir, 'enforce', 'probe.jsonl'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('says so when the hook fails or does not decide, never timing it as a fast start', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'astera-latency-'))
    try {
      const hookFile = path.join(dir, 'hook.cjs')
      writeFileSync(hookFile, "process.stderr.write('boom'); process.exit(1)\n")
      expect(measureHook({ hookFile, runs: 2, interpreters: node }).node).toEqual({ error: 'exit 1: boom' })
      // A hook that exits 0 without reading its Rules, as the real one does when it fails inside
      writeFileSync(hookFile, "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))\n")
      expect(measureHook({ hookFile, runs: 2, interpreters: node }).node).toEqual({ error: 'the hook did not deny git push origin main: ""' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
