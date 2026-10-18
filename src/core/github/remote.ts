// Which GitHub repository a folder's `origin` names (GitHub lifecycle design L24: the lifecycle pushes to origin only),
// and how gh is told about it. Pure.

export interface GitHubRepo {
  host: string
  owner: string
  name: string
}

const SCP = /^[^@\s/]+@([^:\s/]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/
const URL_FORM = /^(?:https?|ssh|git):\/\/(?:[^@\s/]+@)?([^:\s/]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/

/** `https://github.com/o/r(.git)`, `git@github.com:o/r(.git)`, `ssh://git@github.com[:port]/o/r(.git)`, on any host
 *  (GitHub Enterprise included). Null for anything else: a local path, a URL with more or fewer path parts. */
export function parseGitHubRemote(url: string): GitHubRepo | null {
  const u = url.trim()
  const m = SCP.exec(u) ?? URL_FORM.exec(u)
  return m ? { host: m[1].toLowerCase(), owner: m[2], name: m[3] } : null
}

export const repoSlug = (r: GitHubRepo): string => `${r.owner}/${r.name}`

/** gh's `--repo` value: `[HOST/]OWNER/REPO`. */
export const ghRepoArg = (r: GitHubRepo): string => (r.host === 'github.com' ? repoSlug(r) : `${r.host}/${repoSlug(r)}`)

/** The repository a lifecycle binding names: `owner/name`, and its host when that is not github.com. Null for a
 *  repository that is not `owner/name`. */
export function repoOfBinding(b: { repository: string; host?: string }): GitHubRepo | null {
  const parts = b.repository.split('/')
  return parts.length === 2 && parts[0] !== '' && parts[1] !== '' ? { host: b.host ?? 'github.com', owner: parts[0], name: parts[1] } : null
}

/** `gh api` talks to github.com unless told otherwise. */
export const hostnameArgs = (r: GitHubRepo): string[] => (r.host === 'github.com' ? [] : ['--hostname', r.host])
