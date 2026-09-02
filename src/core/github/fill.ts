/** One commit, as `git log --format` hands it over. */
export interface CommitSummary {
  subject: string
  body: string
}

/** Seeds a PR's title and body from the commits the branch adds, following `gh pr create --fill`'s
 *  rule: a single commit speaks for itself, several are summarised under the branch name.
 *  The caller supplies the commits in the order they should appear — this does not sort. */
export function fillFromCommits(
  branch: string,
  commits: CommitSummary[]
): { title: string; body: string } {
  if (commits.length === 1) {
    return { title: commits[0].subject, body: commits[0].body.trim() }
  }
  return {
    title: branch,
    body: commits.map((c) => `- ${c.subject}`).join('\n')
  }
}
