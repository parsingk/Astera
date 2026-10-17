// The open pull request of a Run's branch (GitHub lifecycle design §7): from this repository (not a fork's branch of the
// same name), with this head and this base. The watch binds it when there is exactly one.
import { ghFailureSentence, type GhFailed, type GhRunner } from './gh'
import { ghRepoArg, type GitHubRepo } from './remote'

export interface OpenPr {
  number: number
  url: string
}

export async function findOpenPrs(
  run: GhRunner,
  cwd: string,
  repo: GitHubRepo,
  branch: string,
  base: string
): Promise<{ ok: true; prs: OpenPr[] } | GhFailed> {
  const r = await run(
    ['pr', 'list', '--repo', ghRepoArg(repo), '--head', branch, '--base', base, '--state', 'open', '--limit', '5', '--json', 'number,url,headRefName,baseRefName,isCrossRepository'],
    cwd
  )
  if (!r.ok) return { ok: false, ...ghFailureSentence(r) }
  let rows: unknown
  try {
    rows = JSON.parse(r.stdout)
  } catch {
    rows = null
  }
  if (!Array.isArray(rows)) return { ok: false, kind: 'other', message: 'gh pr list answered with something that is not a list' }
  const prs: OpenPr[] = []
  for (const raw of rows) {
    const p = raw as Record<string, unknown> | null
    if (
      typeof p?.number === 'number' &&
      typeof p.url === 'string' &&
      p.headRefName === branch &&
      p.baseRefName === base &&
      p.isCrossRepository !== true
    )
      prs.push({ number: p.number, url: p.url })
  }
  return { ok: true, prs }
}
