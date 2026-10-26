// What a `gh` call Astera runs is, for its credential-use record (credentials design §6): the action, the repository it
// names and the number it is about. Nothing here decides whether the call runs; the record only says what it was.
import type { CredentialUse } from '../audit/types'

export interface GhUse {
  action: Extract<CredentialUse['action'], `github.${string}`>
  /** `owner/name` from `-R`/`--repo`. */
  repoArg?: string
  /** `#<pr>` for a pull request, the bare id of a run. */
  number?: string
  /** `gh <two words>` for a command that is none of the known ones, read as a read. */
  other?: string
}

const repoFlag = (args: readonly string[]): string | undefined => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const v = a === '-R' || a === '--repo' ? args[i + 1] : a.startsWith('--repo=') ? a.slice('--repo='.length) : undefined
    if (v === undefined) continue
    const parts = v.split('/')
    return parts.length === 3 && parts[0] === 'github.com' ? `${parts[1]}/${parts[2]}` : v
  }
  return undefined
}

/** The first argument after the subcommand that is not a flag: a PR number or a run id. */
const firstPlain = (args: readonly string[]): string | undefined => {
  for (let i = 2; i < args.length; i++) {
    if (args[i].startsWith('-')) {
      if (!args[i].includes('=')) i++
      continue
    }
    return /^\d+$/.test(args[i]) ? args[i] : undefined
  }
  return undefined
}

const WRITE_METHODS = /^(?:POST|PUT|PATCH|DELETE)$/i

export function classifyGh(args: readonly string[]): GhUse {
  const [a, b] = args
  const repoArg = repoFlag(args)
  const withRepo = <T extends GhUse>(u: T): T => (repoArg !== undefined ? { ...u, repoArg } : u)
  if (a === 'pr' && b === 'create') return withRepo({ action: 'github.pr.create' })
  if (a === 'run' && b === 'rerun') {
    const n = firstPlain(args)
    return withRepo({ action: 'github.ci.rerun', ...(n ? { number: n } : {}) })
  }
  if (a === 'pr' && (b === 'view' || b === 'list' || b === 'checks' || b === 'status')) {
    const n = b === 'list' || b === 'status' ? undefined : firstPlain(args)
    return withRepo({ action: 'github.read', ...(n ? { number: `#${n}` } : {}) })
  }
  if (a === 'run' && (b === 'view' || b === 'list')) {
    const n = b === 'view' ? firstPlain(args) : undefined
    return withRepo({ action: 'github.read', ...(n ? { number: n } : {}) })
  }
  if (a === 'repo' && b === 'view') return { action: 'github.read', ...(b && args[2] && !args[2].startsWith('-') ? { repoArg: args[2] } : {}) }
  if (a === 'api') {
    const i = args.findIndex((x) => x === '-X' || x === '--method')
    const method = i >= 0 ? args[i + 1] : args.find((x) => x.startsWith('--method='))?.slice('--method='.length)
    const writes = (method !== undefined && WRITE_METHODS.test(method)) || args.some((x) => x === '-f' || x === '-F' || x === '--input' || x === '--field' || x === '--raw-field')
    return writes ? { action: 'github.write', other: 'gh api' } : withRepo({ action: 'github.read' })
  }
  return withRepo({ action: 'github.read', other: `gh ${[a, b].filter((x) => x !== undefined).join(' ')}` })
}

/** `owner/name` of a github.com origin URL (https, ssh, with or without credentials and `.git`); null otherwise. */
export function repoOfOrigin(url: string | null): string | null {
  if (url === null) return null
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : null
}
