// Text search's wiring in main and preload, read from the source like the other *Wiring tests: the parts are tested on
// their own (textSearch.test.ts, textMatch.test.ts), and what could still go wrong is that ipc.ts stops connecting them.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const ipc = readFileSync(path.resolve(__dirname, 'ipc.ts'), 'utf8')
const preload = readFileSync(path.resolve(__dirname, '../preload/index.ts'), 'utf8')

describe('text search wiring', () => {
  it('answers files.searchText from the shared index, behind the files path guard, one search per renderer', () => {
    expect(ipc).toContain('createTextSearch({ index: fileIndex, allowedRoot: assertAllowedPath })')
    expect(ipc).toContain(
      "ipcMain.handle('files.searchText', (e, root: unknown, query: unknown, refresh?: unknown) => textSearch(e.sender.id, root, query, refresh))"
    )
  })

  it('is on window.api.files', () => {
    expect(preload).toContain("searchText: invoke('files.searchText')")
  })
})
