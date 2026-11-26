// The app's GitHub commands over its orch-call (GitHub lifecycle G7a): sent as the app, answered as the Host answered,
// and a Host that could not be asked said in words a person can act on.
import { describe, it, expect } from 'vitest'
import { HOST_GITHUB_DEADLINE_MS, createHostGitHubRoute } from './hostGitHubRoute'
import { NO_HOST_CONNECTION, hostDeadlineMessage } from './worktreeRoute'

type Sent = { cmd: string; args: Record<string, unknown>; sessionId: string; timeoutMs?: number }

function host(answer: { status: number; body: unknown } | Error) {
  const sent: Sent[] = []
  const route = createHostGitHubRoute({
    call: async (m) => {
      sent.push(m)
      if (answer instanceof Error) throw answer
      return answer
    }
  })
  return { route, sent }
}

describe('createHostGitHubRoute', () => {
  it('sends the command as the app, with time for the gh calls behind it, and answers as the Host answered', async () => {
    const ok = host({ status: 200, body: { id: 'run_1' } })
    expect(await ok.route('run-create', { githubLifecycle: true })).toEqual({ status: 200, body: { id: 'run_1' } })
    expect(ok.sent).toEqual([{ cmd: 'run-create', args: { githubLifecycle: true }, sessionId: '', timeoutMs: HOST_GITHUB_DEADLINE_MS }])
    const refused = host({ status: 409, body: { error: 'the GitHub lifecycle cannot be turned on here: no origin' } })
    expect(await refused.route('run-create', { githubLifecycle: true })).toEqual({ status: 409, body: { error: 'the GitHub lifecycle cannot be turned on here: no origin' } })
  })

  it('a Host that is not running sent nothing: said so, not as a refusal of the command', async () => {
    const { route } = host(new Error(NO_HOST_CONNECTION))
    const r = await route('gate-resolve', { id: 'g_1', resolution: 'continue' })
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ code: 'HOST_NOT_RUNNING' })
    expect((r.body as { error: string }).error).toMatch(/Astera Host is not running/)
  })

  it('a deadline or a lost connection may have reached the Host: said so', async () => {
    const late = await host(new Error(hostDeadlineMessage('run-create', HOST_GITHUB_DEADLINE_MS))).route('run-create', {})
    expect(late.status).toBe(504)
    expect(late.body).toMatchObject({ code: 'TIMEOUT' })
    const lost = await host(new Error('the Host went away')).route('run-create', {})
    expect(lost.status).toBe(502)
    expect(lost.body).toMatchObject({ code: 'HOST_LOST' })
    expect((lost.body as { error: string }).error).toMatch(/may have/)
  })
})
