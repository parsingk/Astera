// Second pass M2-4: a renderer reload never unsubscribed the old page's GitHub and usage panels, so their counts stayed
// above zero and both polls ran for the rest of the app's life with no panel open.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

describe('a new document in the window', () => {
  const ipc = readFileSync(path.join(__dirname, 'ipc.ts'), 'utf8')
  const nav = ipc.slice(ipc.indexOf("win.webContents.on('did-start-navigation'"))
  const handler = nav.slice(0, nav.indexOf('\n  })'))

  it('runs what was registered to forget the old document', () => {
    expect(handler).toContain('for (const forget of onNewDocument) forget()')
  })

  // Second pass M2-6: project terminal and Run output went to the renderer one IPC message per pty chunk, where session
  // output is batched; a chatty dev server cost a message per chunk. Batched the same way, and flushed before the exit or
  // status that must follow the last output.
  it('batches terminal and Run output, flushing it before an exit or a status', () => {
    expect(ipc).toContain("runBatcher.push(e.runId, e.data)")
    expect(ipc).toContain("core.terminal.onData = (e) => terminalBatcher.push(e.id, e.data)")
    const status = ipc.slice(ipc.indexOf('core.run.onStatus = (e) => {'))
    expect(status.slice(0, status.indexOf('\n  }'))).toContain('runBatcher.flush()')
    expect(ipc).toContain("core.terminal.onExit = (e) => {\n    terminalBatcher.flush()")
  })

  // Final review m2: a buffer handed out while chunks it already holds still sat in the batcher was followed by those
  // chunks again: written twice by a view that had subscribed meanwhile. The batch goes first.
  it('sends what the batchers hold before handing out a buffer', () => {
    const list = ipc.slice(ipc.indexOf("ipcMain.handle('terminal.list'"))
    expect(list.slice(0, list.indexOf('\n  })'))).toContain('terminalBatcher.flush()')
    expect(ipc).toContain("ipcMain.handle('run.output', async (_e, runId: string) => {\n    runBatcher.flush()")
  })

  it('stops the GitHub and the usage polls among them', () => {
    expect(ipc).toContain('onNewDocument.push(() => githubPrs.stop())')
    expect(ipc).toContain('onNewDocument.push(() => accountUsage.stop())')
  })
})
