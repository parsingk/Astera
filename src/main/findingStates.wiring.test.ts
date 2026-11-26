import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Phase 3 Part 1b: how main keeps finding states true. ipc.ts needs Electron to load, so its wiring is pinned by its text.
const ipc = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ipc.ts'), 'utf8')

describe('finding states in main', () => {
  it('stamps the mirror as the Host stamps an app put, and sends a person’s dismissals to the Host as commands', () => {
    expect(ipc).toMatch(/createMirrorStore\(\{\s*call: orchCall,\s*stamp: \(prev, next\) => stampFindings\(prev, next, 'person', new Date\(\)\.toISOString\(\), \{ fromApp: true \}\)/)
    const routed = ipc.indexOf('if (hostWritesFinding(cmd)) return hostFindings(cmd, args ?? {})')
    expect(routed).toBeGreaterThan(-1)
    expect(routed).toBeLessThan(ipc.indexOf('return await orchHandleCommand(orch.deps, { sessionId: UI_CALLER }, cmd, args ?? {})'))
  })
})
