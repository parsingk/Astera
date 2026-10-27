// What starting the Enforce hook costs (enforce and sandbox design §10.5, S1's review M6): the hook as the build bundles
// it, run as the CLIs run it, by node and by Electron as node.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractHookSource, measureHook, stats } from './latency.mjs'

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

describe('measureHook', () => {
  it('times a real hook run', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'astera-latency-'))
    try {
      const hookFile = path.join(dir, 'hook.cjs')
      writeFileSync(hookFile, "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))\n")
      const r = measureHook({ hookFile, runs: 3, interpreters: [{ name: 'node', file: process.execPath, env: {} }] })
      expect(r.node.runs).toBe(3)
      expect(r.node.median).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
