// The worktree panel's Create PR (credentials design §6, final review I2): it runs here in the app, as it always has, with
// its push and `gh pr create` recorded as the app's GitHub uses; the records go to the Host, the one writer of credential
// uses. A record the Host cannot take is logged by what it was; the pull request is never held up by it.
import { createPullRequest, defaultPrGit, type PrCreateDeps, type PrCreateRequest, type PrCreateResult } from '../../core/github/prCreate'
import { defaultGhRunner } from '../../core/github/gh'
import { recordingGhRunner, recordingGitRunner, type UseFields } from '../../host/credentials/recordUses'

type Call = (m: { cmd: string; args: Record<string, unknown>; sessionId: string }) => Promise<{ status: number; body: unknown }>

export function createAppPullRequests(d: {
  call: Call
  /** A folder's `origin` URL, which names the repository a record is about. */
  originOf: (cwd: string) => Promise<string | null>
  log: (m: string) => void
  /** Test injection: the runners and the base's normalising, as `createPullRequest` takes them. */
  runGit?: NonNullable<PrCreateDeps['runGit']>
  runGh?: NonNullable<PrCreateDeps['runGh']>
  normalizeBase?: PrCreateDeps['normalizeBase']
}): (req: PrCreateRequest) => Promise<PrCreateResult> {
  return async (req) => {
    const uses: UseFields[] = []
    const rec = { record: (u: UseFields): void => void uses.push(u) }
    const app = { actor: 'app' as const }
    const result = await createPullRequest(req, {
      runGit: recordingGitRunner(d.runGit ?? defaultPrGit, app, rec, { originOf: d.originOf }),
      runGh: recordingGhRunner(d.runGh ?? defaultGhRunner, app, rec, { background: false, originOf: d.originOf }),
      ...(d.normalizeBase ? { normalizeBase: d.normalizeBase } : {})
    })
    if (uses.length > 0) {
      const sent = uses.map((u) => ({ action: u.action, resource: u.resource, outcome: u.outcome }))
      const what = sent.map((u) => `${u.action} ${u.resource} ${u.outcome}`).join('; ')
      void d.call({ cmd: 'credentials-record', args: { uses: sent }, sessionId: '' }).then(
        (r) => {
          if (r.status !== 200) d.log(`credential uses could not be recorded (the Host answered ${r.status}): ${what}`)
        },
        (e: unknown) => d.log(`credential uses could not be recorded (${e instanceof Error ? e.message : String(e)}): ${what}`)
      )
    }
    return result
  }
}
