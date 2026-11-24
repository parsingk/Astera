// Quick Open's wiring in main and preload, read from the source like the other *Wiring tests: the parts are tested on
// their own (fileIndex.test.ts, quickOpen.test.ts), and what could still go wrong is that ipc.ts stops connecting them.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const ipc = readFileSync(path.resolve(__dirname, 'ipc.ts'), 'utf8')
const preload = readFileSync(path.resolve(__dirname, '../preload/index.ts'), 'utf8')

describe('Quick Open wiring', () => {
  it('tells the file index what the explorer watcher saw', () => {
    expect(ipc).toMatch(/new FileWatcher\(\(batch\) => \{[^}]*fileIndex\.noteChanges\(batch\.changes\)/)
  })

  it('answers files.quickOpen from the shared index, behind the files path guard', () => {
    expect(ipc).toContain('createQuickOpen({ index: fileIndex, allowedRoot: assertAllowedPath })')
    expect(ipc).toContain(
      "ipcMain.handle('files.quickOpen', (_e, root: unknown, query: unknown, refresh?: unknown) => quickOpen(root, query, refresh))"
    )
  })

  it('is on window.api.files', () => {
    expect(preload).toContain("quickOpen: invoke('files.quickOpen')")
  })
})
