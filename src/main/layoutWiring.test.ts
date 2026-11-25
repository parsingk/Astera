import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// The layout restore's two main-side asks (spec W3), pinned by text like the other IPC wiring tests.
const here = path.dirname(fileURLToPath(import.meta.url))
const ipc = readFileSync(path.join(here, 'ipc.ts'), 'utf8')
const preload = readFileSync(path.join(here, '../preload/index.ts'), 'utf8')

describe('the layout restore in main (spec W3, final review I1 and M5)', () => {
  it('lists the sessions once the Host has handed them back, when asked, for a bounded time', () => {
    expect(ipc).toMatch(/ipcMain\.handle\('sessions\.list', async \(_e, opts\?: unknown\) => \{\s*if \(afterTakeBack\(opts\)\)\s*await Promise\.race\(\[hostSessionsTakenBack, new Promise\(\(r\) => setTimeout\(r, SESSIONS_TAKEN_BACK_WAIT_MS\)\)\]\)\s*return allSessions\(\)/)
  })

  it('answers whether a saved file or record folder is there through the project guard', () => {
    expect(ipc).toMatch(/ipcMain\.handle\('files\.exists', \(_e, p: unknown, kind: unknown\) =>\s*existsInProject\(p, kind, \{ assertAllowedPath, stat: \(f\) => fs\.stat\(f\) \}\)/)
    expect(preload).toMatch(/exists: invoke\('files\.exists'\)/)
  })
})
