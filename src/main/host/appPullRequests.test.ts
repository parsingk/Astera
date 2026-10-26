// The app's own Create PR (credentials design §6, final review I2): it runs in the app, and its push and `gh pr create`
// reach the Host's credential uses as the app's, names and outcomes only, without holding the pull request up.
import { describe, it, expect } from 'vitest'
import { createAppPullRequests } from './appPullRequests'
import type { GhRunner } from '../../core/github/gh'
import type { PrCreateRequest } from '../../core/github/prCreate'

const req: PrCreateRequest = { worktreePath: 'D:/wt/x', repoPath: 'D:/repo', branch: 'feat/x', base: 'main', title: 't', body: 'b', draft: false, needsPush: true }
const originOf = async (): Promise<string | null> => 'https://github.com/o/r.git'
type Sent = { cmd: string; args: Record<string, unknown>; sessionId: string }

describe('the app\u2019s pull requests', () => {
  it('sends the push and the create to the Host as the app\u2019s uses', async () => {
    const sent: Sent[] = []
    const runGh: GhRunner = async () => ({ ok: true, stdout: 'https://github.com/o/r/pull/7\n', stderr: '', exitCode: 0 })
    const create = createAppPullRequests({
      call: async (m) => (sent.push(m), { status: 200, body: {} }),
      originOf,
      log: () => {},
      runGit: async () => ({ ok: true, stdout: '', stderr: '' }),
      runGh,
      normalizeBase: async (_repo, base) => base
    })
    const r = await create(req)
    expect(r.ok).toBe(true)
    await new Promise((resolve) => setImmediate(resolve))
    expect(sent).toEqual([
      {
        cmd: 'credentials-record',
        args: {
          uses: [
            { action: 'git.remote.write', resource: 'o/r feat/x', outcome: 'ok' },
            { action: 'github.pr.create', resource: 'o/r', outcome: 'ok' }
          ]
        },
        sessionId: ''
      }
    ])
  })

  it('answers the pull request when the Host cannot take the records, and says so in the log', async () => {
    const logged: string[] = []
    const create = createAppPullRequests({
      call: async () => Promise.reject(new Error('no Host connection')),
      originOf,
      log: (m) => void logged.push(m),
      runGit: async () => ({ ok: false, stdout: '', stderr: 'rejected: secret ghp_x' }),
      runGh: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0 }),
      normalizeBase: async (_repo, base) => base
    })
    const r = await create(req)
    expect(r).toMatchObject({ ok: false, stage: 'push' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(logged.join('\n')).toMatch(/could not be recorded/)
    expect(logged.join('\n')).not.toMatch(/ghp_/)
  })
})
