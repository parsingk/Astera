// The gh calls that carry a Run's report to its pull request (run report C2, spec §10): post once, edit by the id kept,
// find by the hidden marker when a post may have landed unseen. Never `--edit-last`: it would edit a person's own latest
// comment. Pure over the injected runner.
import { ghFailureSentence, type GhFailed, type GhRunner } from './gh'
import { ghRepoArg, hostnameArgs, repoSlug, type GitHubRepo } from './remote'

const COMMENT_ID = /#issuecomment-(\d+)/

export async function postPrComment(
  run: GhRunner,
  cwd: string,
  repo: GitHubRepo,
  pr: number,
  body: string
): Promise<{ ok: true; id: number; url: string } | GhFailed> {
  const r = await run(['pr', 'comment', String(pr), '--repo', ghRepoArg(repo), '--body', body], cwd)
  if (!r.ok) return { ok: false, ...ghFailureSentence(r) }
  const url = r.stdout.match(/\S*#issuecomment-\d+/)?.[0]
  const id = url === undefined ? undefined : url.match(COMMENT_ID)?.[1]
  if (url === undefined || id === undefined) return { ok: false, kind: 'other', message: 'gh pr comment answered without the comment URL' }
  return { ok: true, id: Number(id), url }
}

export async function editIssueComment(run: GhRunner, cwd: string, repo: GitHubRepo, id: number, body: string): Promise<{ ok: true } | GhFailed> {
  const r = await run(['api', ...hostnameArgs(repo), '--method', 'PATCH', `repos/${repoSlug(repo)}/issues/comments/${id}`, '-f', `body=${body}`], cwd)
  return r.ok ? { ok: true } : { ok: false, ...ghFailureSentence(r) }
}

export async function findReportComment(
  run: GhRunner,
  cwd: string,
  repo: GitHubRepo,
  pr: number,
  marker: string
): Promise<{ ok: true; found: { id: number; url: string } | null } | GhFailed> {
  const r = await run(
    [
      'api',
      ...hostnameArgs(repo),
      '--paginate',
      `repos/${repoSlug(repo)}/issues/${pr}/comments?per_page=100`,
      '--jq',
      `.[] | select(.body | contains("${marker}")) | "\\(.id) \\(.html_url)"`
    ],
    cwd
  )
  if (!r.ok) return { ok: false, ...ghFailureSentence(r) }
  const first = r.stdout.split('\n').map((l) => l.trim()).find((l) => l !== '')
  const m = first?.match(/^(\d+) (\S+)$/)
  return { ok: true, found: m ? { id: Number(m[1]), url: m[2] } : null }
}
