// An agent-started session's tab closes when it ends (2026-10-20). The app starts a Job's workers, reviewers, repair
// and integration workers through the OrchCoordinator's spawnSession, and its coordinators through startCoordinator's
// spawn: both mark the session as an agent's. The person's own path (sessions.spawn) does not. registerIpc cannot run
// without Electron, so the wiring is guarded by its text, as chatAdopt.test.ts guards the chat adopter's.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ipc.ts'), 'utf8')
const between = (from: string, to: string): string => {
  const start = src.indexOf(from)
  const end = src.indexOf(to, start)
  if (start < 0 || end < 0) throw new Error(`not found: ${from} … ${to}`)
  return src.slice(start, end)
}

describe('ipc.ts marks the sessions an agent starts', () => {
  it('a Job’s worker, reviewer and repair worker (the OrchCoordinator’s spawnSession)', () => {
    const worker = between('      spawnSession: async (o) => {', "send('session:created', info)")
    expect(worker).toMatch(/startedBy: 'agent'/)
  })

  it('a Job’s coordinator (startCoordinator’s spawn)', () => {
    const coordinator = between('      startCoordinator: (a) =>', "send('session:created', info)")
    expect(coordinator).toMatch(/spawnSession\(\{ \.\.\.o, startedBy: 'agent' \}\)/)
  })

  // Review M2: the shared body both paths go through, not only the handler's line
  it('never the person’s own new session, nor the body both paths share', () => {
    expect(between('  async function spawnSession(opts: any)', "ipcMain.handle('sessions.spawn'")).not.toMatch(/startedBy/)
    expect(between("ipcMain.handle('sessions.spawn'", '\n')).not.toMatch(/startedBy/)
  })
})
