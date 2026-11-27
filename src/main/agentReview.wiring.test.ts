import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Phase 3 Part 4: main and the Host both answer runs-changed-files, so both give it git ancestry and the observe audit.
// ipc.ts and host/index.ts start whole processes, so their wiring is pinned by their text.
const here = path.dirname(fileURLToPath(import.meta.url))
const ipc = readFileSync(path.join(here, 'ipc.ts'), 'utf8')
const host = readFileSync(path.join(here, '../host/index.ts'), 'utf8')

describe('agent-aware review wiring', () => {
  it('gives the changed-files commands git ancestry and the observe audit, in main and in the Host', () => {
    for (const src of [ipc, host]) {
      expect(src).toMatch(/isAncestor: \(repo, base, head\) => isAncestorOf\(repo, base, head\)/)
      expect(src).toMatch(/auditWrites: \(a\) => auditWriteTargets\(/)
    }
    expect(ipc).toContain("auditWriteTargets(app.getPath('userData'), a)")
    expect(host).toContain('auditWriteTargets(profileDir, a)')
  })
})
