// Audit U-6: an installer that hung kept `installingCli` true until a restart (every retry answered ALREADY_RUNNING), and
// kept running after the app quit. The install has a time limit and goes with the app.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

describe('system.installCli', () => {
  const ipc = readFileSync(path.join(__dirname, 'ipc.ts'), 'utf8')
  const start = ipc.indexOf("ipcMain.handle('system.installCli'")
  const handler = ipc.slice(start, ipc.indexOf("ipcMain.handle('system.relaunch'", start))

  it('ends an install that runs past INSTALL_CLI_TIMEOUT_MS, with its whole tree', () => {
    expect(handler).toContain('INSTALL_CLI_TIMEOUT_MS')
    expect(handler).toContain('killProcessTree(child)')
  })
  it('kills an install still running when the app quits', () => {
    expect(handler).toContain("app.once('will-quit'")
  })
})
