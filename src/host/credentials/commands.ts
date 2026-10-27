// The Host's `credentials-*` commands (credentials design §4, §7): the Credentials list, its hiding and the uses recorded
// through Astera. The Host owns credentials.json; the app's Settings › Security & Access changes it through here and this
// machine's CLI reads it. Only the app changes it: an agent's shell must not switch off the hiding of its own session's
// keys, and under the same-user limit nothing but the app's role on the pipe tells a person from an agent (design §4).
import { RepairNeeded } from '../../core/settings/repairNeeded'
import type { OrchCaller } from '../../core/host/orchProtocol'
import { readExtensionRegistry } from '../../core/extensions/registry'
import { mcpSecretEntries } from '../../core/credentials/mcpEntries'
import { PRESETS, PRESET_IDS } from '../../core/credentials/presets'
import { CredentialsDamaged, isEnvName, newHideOnlyId, readCredentials, validateHideOnly, writeCredentials } from '../../core/credentials/store'
import { lastUses, queryCredentialUses } from '../../core/credentials/uses'
import type { CredentialUse } from '../../core/audit/types'
import type { UseFields } from './recordUses'
import type { CredentialsFile, HideOnlyEntry, Hiding } from '../../core/credentials/types'
import { keepDamaged, readStoreFile } from '../../core/storeFile'
import { profilePaths } from '../../core/profile/paths'

export const CREDENTIAL_COMMANDS: ReadonlySet<string> = new Set([
  'credentials-list',
  'credentials-show',
  'credentials-doctor',
  'credentials-uses',
  'credentials-add-hide-only',
  'credentials-edit-hide-only',
  'credentials-delete-hide-only',
  'credentials-set-hiding',
  'credentials-reset',
  'credentials-record'
])

/** The app's alone: the list's changes, and the records of the GitHub writes the app makes itself. */
export const CREDENTIAL_CHANGES: ReadonlySet<string> = new Set([
  'credentials-add-hide-only',
  'credentials-edit-hide-only',
  'credentials-delete-hide-only',
  'credentials-set-hiding',
  'credentials-reset',
  'credentials-record'
])

/** What the app may record of its own: GitHub uses with its login (final review I2). */
const APP_USE_ACTIONS: ReadonlySet<string> = new Set(['github.read', 'github.pr.create', 'github.ci.rerun', 'github.write', 'git.remote.write'])
const APP_USES_MAX = 20
const RESOURCE_MAX = 200

export interface CredentialsAnswer {
  status: number
  body: unknown
}

export interface HostCredentials {
  command(a: {
    cmd: string
    args: Record<string, unknown>
    role: OrchCaller['role'] | undefined
    /** The sentence an agent's shell is refused with, present exactly when the caller is one. */
    agentRefusal?: string
    marks: { effects: number }
  }): Promise<CredentialsAnswer>
}

const bad = (error: string, reason?: string): CredentialsAnswer => ({ status: 400, body: { error, ...(reason ? { reason } : {}) } })
const notFound = (what: string): CredentialsAnswer => ({ status: 404, body: { error: `no credentials entry ${what}` } })
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string')

function hidingArg(v: unknown): Hiding | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (typeof o.on !== 'boolean') return null
  if (o.projects === undefined) return { on: o.on }
  return isStrings(o.projects) && o.projects.length > 0 ? { on: o.on, projects: o.projects } : null
}

const REFUSALS: Record<string, string> = {
  'protected-name': 'that variable is one Claude, Codex or Astera need to run, so it cannot be hidden',
  'system-name': 'that variable is one the OS gives every program and a session needs to run, so it cannot be hidden',
  'alias-taken': 'another entry already has that name',
  'bad-name': 'a variable name is letters, digits and _ and does not start with a digit',
  empty: 'name at least one variable or pick a preset',
  'unknown-preset': `presets are ${PRESET_IDS.join(', ')}`,
  'alias-empty': 'give the entry a name'
}

/** The limits doctor states, whatever the list holds (credentials design §7). */
const LIMITS = [
  'Hiding keeps what is listed out of the sessions Astera starts; a program running as the same user can still read your files and OS stores.',
  'git hands its stored logins to any program that asks (git credential fill, measured 2026-10-26); git logins are not hidden.',
  'Docker’s credential helper answers any program that asks, whatever the Docker preset redirects.',
  'The app’s role on the Host pipe is a claim the Host cannot verify against a program of the same user.',
  'A variable your shell startup files set can come back in the commands an agent runs through a shell that reads them. Codex starts its commands as a login shell: on macOS and Linux a login bash reads ~/.bash_profile (or ~/.bash_login, ~/.profile) and a login zsh ~/.zshenv, ~/.zprofile and ~/.zlogin (measured 2026-10-27), and on Windows PowerShell reads your profile. For Claude Code, which takes the aliases and functions of your startup file at session start, this is not measured.'
]

/** What an agent profile's sandbox switch does, per CLI and OS (sandbox design §6), whatever this machine is: the switch
 *  is set in one place for every OS a profile's sessions may start on. Windows was measured on the build's PC (inventory
 *  §23.3), macOS and Linux on GitHub's runners (§22, §23.4). */
const LOGIN_FOLDERS = '~/.ssh, ~/.aws, gh’s and gcloud’s settings, ~/.docker, ~/.npmrc, ~/.git-credentials and ~/.kube'
const SANDBOX_LINES: { level: 'ok' | 'warn'; text: string }[] = [
  {
    level: 'ok',
    text: `Sandbox, Codex on Windows: Codex’s elevated sandbox, set up once for each Codex account; writes stay in the session’s folder, its repository’s git directories (not their hooks or config) and the temp folder, ${LOGIN_FOLDERS} cannot be read, Credential Manager is kept out, and the network works.`
  },
  {
    level: 'ok',
    text: `Sandbox, Codex on macOS: Codex’s own sandbox; writes stay in the session’s folder, its repository’s git directories (not their hooks or config) and the temp folder, ${LOGIN_FOLDERS} and ~/Library/Keychains cannot be read, and the network works.`
  },
  {
    level: 'ok',
    text: `Sandbox, Codex on Linux: Codex’s own sandbox; writes stay in the session’s folder, its repository’s git directories (not their hooks or config) and the temp folder, ${LOGIN_FOLDERS} cannot be read, the session bus a secret service answers on cannot be reached when the session bus is a file path (a bus on an abstract socket is not denied), and the network works.`
  },
  {
    level: 'warn',
    text: `Sandbox, Claude Code on Windows: Claude Code has no sandbox here; the switch adds deny rules that keep its file tools out of ${LOGIN_FOLDERS}, and its shell is not restricted.`
  },
  {
    level: 'ok',
    text: `Sandbox, Claude Code on macOS: Claude Code’s own sandbox; its commands write only in the session’s folder, its git directories and the temp folder, ${LOGIN_FOLDERS} and ~/Library/Keychains cannot be read, astera runs outside it, and the network works.`
  },
  {
    level: 'ok',
    text: `Sandbox, Claude Code on Linux: Claude Code’s own sandbox; its commands write only in the session’s folder, its git directories and the temp folder, ${LOGIN_FOLDERS} cannot be read, the session bus cannot be reached, astera runs outside it, and the network works.`
  },
  {
    level: 'ok',
    text: 'Inside Claude Code’s sandbox on Linux, `git add -A` fails on the placeholders the sandbox keeps for files it protects (such as .bashrc and .vscode); Astera points a sandboxed Claude Code session’s git at an excludes file of its own (your excludes, then those names), so `git add -A` works.'
  }
]

/** The sandbox's known limits (sandbox design §6), and those the build found. */
const SANDBOX_LIMITS = [
  'Inside a sandboxed Codex session on Windows, curl fails TLS.',
  'gh inside the sandbox cannot use your login, so GitHub work goes through Astera (astera github-*).',
  'Git pushes from inside the sandbox use git’s login only where the sandbox lets the credential helper run; on Windows it does not, so pushes stay with the Host as today.',
  'A chain keeps the sandbox state it started with: the session a roll starts next is in the sandbox exactly when the first one was, whatever the profile’s switch says by then.',
  'A worktree a sandboxed Codex session adds itself has a config.worktree its sandbox profile does not name, so the session can write that file; the worktrees there when it started are named, and kept read-only.',
  'On Windows, setting up one Codex account’s sandbox can leave another account’s setup stale (from Codex’s source, not measured). Astera asks before each sandboxed start, with Codex’s doctor first and a sandboxed echo only on a home doctor calls complete; a ready answer is kept for the process’s life and dropped only by a setup run through Astera, so a home made stale by a setup outside Astera keeps reading ready until Astera restarts. A home found stale is not started on until it is set up again (Set up, in Settings › Agent profiles).',
  'Claude Code’s use of its sandbox settings is measured on the runtime it uses (srt 0.0.79), not with Claude Code itself.'
]

export function createHostCredentials(d: {
  profileDir: string
  platform?: NodeJS.Platform
  now?: () => number
  onChange?: (cmd: string) => void
  /** The environment sessions inherit (the Host's own): only its names are read. */
  env?: Record<string, string | undefined>
  /** The projects this Host has registered, which an entry can be narrowed to (C9). */
  projects?: () => Promise<readonly { path: string; name: string }[]>
  /** Keeps a credential use (the Host's recorder): the app's own GitHub writes come here. */
  record?: (u: UseFields) => void
}): HostCredentials {
  const platform = d.platform ?? process.platform
  const now = d.now ?? Date.now
  const env = d.env ?? process.env
  /** Whether a session would inherit any of these variables: names compared as the platform does (Windows ignores case). */
  const inEnv = (names: readonly string[]): boolean => {
    const fold = (n: string): string => (platform === 'win32' ? n.toUpperCase() : n)
    const have = new Set(Object.keys(env).filter((k) => env[k] !== undefined).map(fold))
    return names.some((n) => have.has(fold(n)))
  }
  let chain: Promise<unknown> = Promise.resolve()
  const queued = <T>(f: () => Promise<T>): Promise<T> => {
    const run = chain.then(f, f)
    chain = run.catch(() => {})
    return run
  }

  /** The entries as the list answers them. `present`: whether a session started now inherits any of an entry's variables,
   *  so hiding them changes something (the screen says so when not). */
  const entriesOf = async (f: CredentialsFile) => {
    const registry = await readExtensionRegistry(d.profileDir).catch(() => ({ version: 1 as const, entries: [] }))
    const shared = mcpSecretEntries(registry, f.mcpHide)
    const last = await lastUses(
      d.profileDir,
      shared.map((e) => e.id),
      { now }
    ).catch(() => new Map<string, string>())
    const mcp = shared.map((e) => {
      const listed = { ...e, present: inEnv(e.envNames) }
      const at = last.get(e.id)
      return at !== undefined ? { ...listed, lastUsedAt: at } : listed
    })
    return [...f.entries.map((e) => ({ ...e, present: inEnv(e.envNames) })), ...mcp]
  }

  /** Whether another registered entry has this name, whatever its case: show finds an entry by it (final review M7). */
  const taken = (f: CredentialsFile, alias: string, except?: string): boolean =>
    f.entries.some((x) => x.id !== except && x.alias.toLowerCase() === alias.toLowerCase())

  const change = (f: (file: CredentialsFile) => CredentialsFile | CredentialsAnswer, answer: (file: CredentialsFile) => unknown): Promise<CredentialsAnswer> =>
    queued(async () => {
      const file = await readCredentials(d.profileDir)
      const next = f(file)
      if ('status' in next) return next
      await writeCredentials(d.profileDir, next)
      return { status: 200, body: answer(next) }
    })

  const hideOnlyArgs = (args: Record<string, unknown>, base?: HideOnlyEntry): Omit<HideOnlyEntry, 'id' | 'createdAt' | 'kind'> | CredentialsAnswer => {
    const alias = args.alias === undefined && base ? base.alias : args.alias
    const envNames = args.envNames === undefined && base ? base.envNames : args.envNames
    const presets = args.presets === undefined && base ? base.presets : (args.presets ?? [])
    const hide = args.hide === undefined ? (base?.hide ?? { on: true }) : hidingArg(args.hide)
    if (typeof alias !== 'string') return bad('--alias is required')
    if (!isStrings(envNames ?? [])) return bad('variable names must be a list of names')
    if (!isStrings(presets)) return bad('presets must be a list of preset ids')
    if (hide === null) return bad('hiding is { on, projects? } with at least one project when projects is given')
    const e = { alias: alias.trim(), envNames: [...new Set((envNames as string[] | undefined) ?? [])], presets: [...new Set(presets)], hide }
    const v = validateHideOnly(e, PRESET_IDS)
    return v.ok ? e : bad(REFUSALS[v.reason], v.reason)
  }

  /** `agent`: the caller is an agent's shell, which reads the list but not the uses (final review M6). */
  const answer = async (cmd: string, args: Record<string, unknown>, agent: boolean): Promise<CredentialsAnswer> => {
    switch (cmd) {
      case 'credentials-list': {
        const file = await readCredentials(d.profileDir)
        // The projects are a choice offered, not the list: a state that cannot be read leaves none to pick
        const projects = ((await d.projects?.().catch(() => [])) ?? []).map((p) => ({ path: p.path, name: p.name }))
        return {
          status: 200,
          body: { entries: await entriesOf(file), presets: PRESETS.map((p) => ({ id: p.id, label: p.label, measuredOn: p.measuredOn })), projects }
        }
      }
      case 'credentials-show': {
        const key = typeof args.id === 'string' ? args.id : null
        if (key === null) return bad('an id or a name is required')
        const entries = await entriesOf(await readCredentials(d.profileDir))
        const nameOf = (x: (typeof entries)[number]): string => (x.kind === 'hide-only' ? x.alias : x.serverName)
        const byId = entries.find((x) => x.id === key)
        const byName = entries.filter((x) => nameOf(x).toLowerCase() === key.toLowerCase())
        if (!byId && byName.length > 1)
          return { status: 409, body: { error: `${byName.length} entries are named ${key}; use the id (${byName.map((x) => x.id).join(', ')})` } }
        const e = byId ?? byName[0]
        if (!e) return notFound(key)
        if (agent) return { status: 200, body: { entry: e } }
        const uses = e.kind === 'mcp-secret' ? await queryCredentialUses(d.profileDir, { entryId: e.id, limit: 20 }, { now }) : []
        return { status: 200, body: { entry: e, uses } }
      }
      case 'credentials-uses': {
        const limit = args.limit === undefined ? 200 : Number(args.limit)
        if (!Number.isInteger(limit) || limit < 1 || limit > 2000) return bad('--limit is from 1 to 2000')
        const str = (k: string): string | undefined => (typeof args[k] === 'string' ? (args[k] as string) : undefined)
        const provider = str('provider')
        if (provider !== undefined && provider !== 'mcp' && provider !== 'github') return bad('--provider is mcp or github')
        const uses = await queryCredentialUses(
          d.profileDir,
          {
            ...(str('entryId') ? { entryId: str('entryId') } : {}),
            ...(provider ? { provider } : {}),
            ...(str('sessionId') ? { sessionId: str('sessionId') } : {}),
            ...(str('until') ? { until: str('until') } : {}),
            ...(str('beforeId') ? { beforeId: str('beforeId') } : {}),
            limit
          },
          { now }
        )
        return { status: 200, body: { uses, truncated: uses.length === limit } }
      }
      case 'credentials-doctor': {
        const lines: { level: 'ok' | 'warn'; text: string }[] = []
        let file: CredentialsFile | null = null
        try {
          file = await readCredentials(d.profileDir)
          lines.push({ level: 'ok', text: 'The list file reads correctly.' })
        } catch (e) {
          lines.push({ level: 'warn', text: `The list file cannot be used, so the entries you added are not hidden; shared MCP servers’ keys stay hidden by default: ${message(e)}` })
        }
        if (file) {
          for (const e of await entriesOf(file)) {
            const name = e.kind === 'hide-only' ? e.alias : e.serverName
            const where = e.hide.projects ? ` in ${e.hide.projects.join(', ')}` : ' in every agent session'
            lines.push({ level: 'ok', text: `${name}: ${e.hide.on ? `hidden${where}` : 'not hidden'} (${[...e.envNames, ...(e.kind === 'hide-only' ? e.presets.map((p) => `preset ${p}`) : [])].join(', ') || 'nothing'})` })
          }
        }
        for (const p of PRESETS) {
          const here = p.measuredOn.includes(platform)
          lines.push({ level: here ? 'ok' : 'warn', text: `${p.id}: measured on ${p.measuredOn.join(', ')}${here ? '' : `; not measured on ${platform}`}` })
        }
        lines.push({
          level: 'ok',
          text: 'Never hidden: ASTERA_*, CLAUDE_*, CODEX_*, ANTHROPIC_*, OPENAI_* (the CLIs and Astera need them), and what the OS gives every program (PATH, TEMP, TMP, TMPDIR, HOME, USERPROFILE, APPDATA, SystemRoot and the like).'
        })
        lines.push({
          level: 'ok',
          text: 'Each session gets its own empty locations for the CLI logins a preset hides, so a login made inside a session stays in that session; those of a session not started for 30 days are removed.'
        })
        for (const t of LIMITS) lines.push({ level: 'warn', text: t })
        if (platform === 'win32') lines.push({ level: 'warn', text: 'The Host’s Windows pipe keeps the default access list (Node cannot narrow it): any local program can connect.' })
        lines.push({ level: 'ok', text: 'A change counts for sessions started afterwards; a running session keeps its environment.' })
        // An agent profile's sandbox switch (sandbox design §6): what it does on each OS, and what it cannot
        lines.push(...SANDBOX_LINES)
        for (const t of SANDBOX_LIMITS) lines.push({ level: 'warn', text: t })
        return { status: 200, body: { lines } }
      }
      case 'credentials-add-hide-only': {
        const e = hideOnlyArgs(args)
        if ('status' in e) return e
        const entry: HideOnlyEntry = { kind: 'hide-only', id: newHideOnlyId(), ...e, createdAt: new Date(now()).toISOString() }
        return change((f) => (taken(f, entry.alias) ? bad(REFUSALS['alias-taken'], 'alias-taken') : { ...f, entries: [...f.entries, entry] }), () => ({ entry }))
      }
      case 'credentials-edit-hide-only': {
        const id = typeof args.id === 'string' ? args.id : null
        if (id === null) return bad('--id is required')
        let edited: HideOnlyEntry | null = null
        return change(
          (f) => {
            const base = f.entries.find((x) => x.id === id)
            if (!base) return notFound(id)
            const e = hideOnlyArgs(args, base)
            if ('status' in e) return e
            if (taken(f, e.alias, id)) return bad(REFUSALS['alias-taken'], 'alias-taken')
            edited = { ...base, ...e }
            return { ...f, entries: f.entries.map((x) => (x.id === id ? edited! : x)) }
          },
          () => ({ entry: edited })
        )
      }
      case 'credentials-delete-hide-only': {
        const id = typeof args.id === 'string' ? args.id : null
        if (id === null) return bad('--id is required')
        return change((f) => (f.entries.some((x) => x.id === id) ? { ...f, entries: f.entries.filter((x) => x.id !== id) } : notFound(id)), () => ({ deleted: id }))
      }
      case 'credentials-set-hiding': {
        const id = typeof args.id === 'string' ? args.id : null
        const hide = hidingArg(args.hide)
        if (id === null || hide === null) return bad('--id and hiding { on, projects? } are required')
        if (id.startsWith('mcp:')) {
          const serverId = id.slice('mcp:'.length)
          const registry = await readExtensionRegistry(d.profileDir)
          if (!mcpSecretEntries(registry, {}).some((e) => e.serverId === serverId)) return notFound(id)
          return change((f) => ({ ...f, mcpHide: { ...f.mcpHide, [serverId]: hide } }), () => ({ id, hide }))
        }
        return change(
          (f) => (f.entries.some((x) => x.id === id) ? { ...f, entries: f.entries.map((x) => (x.id === id ? { ...x, hide } : x)) } : notFound(id)),
          () => ({ id, hide })
        )
      }
      case 'credentials-reset':
        // The repair of a damaged list: its bytes are kept beside it first (never written over without a copy), then the
        // list starts empty. A file that cannot be read at all is left alone.
        return queued(async () => {
          const file = profilePaths(d.profileDir).credentials
          const read = await readStoreFile(file)
          if (read.kind === 'unreadable') throw new RepairNeeded(`credentials.json could not be read (${String(read.error)})`, 'credentials.json')
          if (read.kind === 'text') await keepDamaged(file, read.text)
          await writeCredentials(d.profileDir, { version: 1, entries: [], mcpHide: {} })
          return { status: 200, body: { entries: [] } }
        })
      case 'credentials-record': {
        // The GitHub writes the app makes itself (its worktree panel's Create PR, final review I2), kept here with every other
        // use, as the app's. An action, a repository and an outcome each: never text the app was told, which can quote a
        // secret.
        const uses = Array.isArray(args.uses) ? (args.uses as unknown[]) : []
        const fields: UseFields[] = []
        for (const u of uses) {
          const o = typeof u === 'object' && u !== null ? (u as Record<string, unknown>) : {}
          const { action, resource, outcome } = o
          if (typeof action !== 'string' || !APP_USE_ACTIONS.has(action)) return bad(`an app use is one of ${[...APP_USE_ACTIONS].join(', ')}`)
          if (typeof resource !== 'string' || resource === '' || resource.length > RESOURCE_MAX) return bad(`an app use names its repository in 1 to ${RESOURCE_MAX} characters`)
          if (outcome !== 'ok' && outcome !== 'failed') return bad('an app use ends ok or failed')
          fields.push({ actor: 'app', provider: 'github', action: action as CredentialUse['action'], resource, outcome, evidence: 'observed' })
        }
        if (fields.length === 0 || fields.length > APP_USES_MAX) return bad(`uses is a list of 1 to ${APP_USES_MAX} { action, resource, outcome }`)
        if (!d.record) return { status: 501, body: { error: 'this Host keeps no credential uses' } }
        for (const u of fields) d.record(u)
        return { status: 200, body: { recorded: fields.length } }
      }
      default:
        return { status: 501, body: { error: `${cmd} is not answered by this Host` } }
    }
  }

  return {
    command: async (a) => {
      if (a.role !== 'app' && a.role !== 'cli') return { status: 403, body: { error: `${a.cmd} is for this machine's app and CLI only` } }
      if (CREDENTIAL_CHANGES.has(a.cmd) && a.role !== 'app') return { status: 403, body: { error: `${a.cmd}: the Credentials list is changed only in the Astera app` } }
      if (a.cmd === 'credentials-uses' && a.agentRefusal !== undefined) return { status: 403, body: { error: a.agentRefusal } }
      let r: CredentialsAnswer
      try {
        r = await answer(a.cmd, a.args, a.agentRefusal !== undefined)
      } catch (e) {
        r = {
          status: e instanceof RepairNeeded ? 409 : 500,
          body: { error: message(e), ...(e instanceof CredentialsDamaged ? { reason: 'damaged' } : {}) }
        }
      }
      if (r.status === 200 && CREDENTIAL_CHANGES.has(a.cmd)) {
        a.marks.effects += 1
        d.onChange?.(a.cmd)
      }
      return r
    }
  }
}
