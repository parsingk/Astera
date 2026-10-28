// The tree kill's ps listings take the desk request limit (DESK_REQUEST_MS), not the 30 s every other
// tool gets: a hung ps must not hold a close or a relaunch that long (review M3). Its own file, since it
// replaces node:child_process for everything it imports. ps answers nothing here, so nothing is ever
// signalled.
import { describe, it, expect, vi } from 'vitest'

const calls: Array<{ file: string; args: string[]; timeout: unknown }> = []
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return {
    ...real,
    execFile: (file: string, args: string[], opts: { timeout?: number }, cb: (err: Error | null, stdout: string) => void) => {
      calls.push({ file, args, timeout: opts.timeout })
      cb(null, '')
    }
  }
})

describe('the tree kill: ps timeout', () => {
  it('lists the table within the desk request limit, from the desks and from native killTree alike', async () => {
    const { DESK_REQUEST_MS } = await import('../../core/workspace/protocol')
    const { PS_TREE_ARGS, killPosixTree } = await import('./posixProc')
    const { realLinuxDeskDeps } = await import('./deskLinux')
    const { realMacDeskDeps } = await import('./deskMac')
    const { killTree } = await import('./native')
    await killPosixTree(999_999)
    await realLinuxDeskDeps({ hostEnv: {}, log: () => {} }).killTree(999_999)
    await realMacDeskDeps({ log: () => {} }).killTree(999_999)
    await killTree(999_999, undefined, 'linux')
    expect(DESK_REQUEST_MS).toBe(15_000)
    expect(calls).toEqual(Array.from({ length: 4 }, () => ({ file: 'env', args: PS_TREE_ARGS, timeout: DESK_REQUEST_MS })))
  })
})
