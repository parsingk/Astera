// A command main sends to the Host as the app (final review M5: the general route in its own file, as its siblings are).
import { describe, it, expect } from 'vitest'
import { createHostRoute } from './hostRoute'
import { NO_HOST_CONNECTION } from './worktreeRoute'

type Sent = { cmd: string; args: Record<string, unknown>; sessionId: string; timeoutMs?: number }
// Phase 3 Part 1b: a person's dismissals are the Host's to write, sent the same way with words of their own
describe('createHostRoute', () => {
  it('sends the command as the app and answers as the Host answered, or says in its own words the Host is not running', async () => {
    const sent: Sent[] = []
    const route = createHostRoute({
      call: async (m) => {
        sent.push(m)
        if (m.cmd === 'tasks-undismiss') throw new Error(NO_HOST_CONNECTION)
        return { status: 200, body: { taskId: 't1', dismissed: 1 } }
      },
      notRunning: 'NOT-RUNNING-WORDS'
    })
    expect(await route('tasks-dismiss', { task: 't1', finding: ['check:t1:a'], note: 'n' })).toEqual({ status: 200, body: { taskId: 't1', dismissed: 1 } })
    expect(sent[0]).toEqual({ cmd: 'tasks-dismiss', args: { task: 't1', finding: ['check:t1:a'], note: 'n' }, sessionId: '' })
    expect(await route('tasks-undismiss', { task: 't1', finding: ['check:t1:a'] })).toEqual({ status: 409, body: { code: 'HOST_NOT_RUNNING', error: 'NOT-RUNNING-WORDS' } })
  })
})
