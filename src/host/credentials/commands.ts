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
import { queryCredentialUses } from '../../core/credentials/uses'
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
  'credentials-reset'
])

/** The ones that change the list: the app's alone. */
export const CREDENTIAL_CHANGES: ReadonlySet<string> = new Set([
  'credentials-add-hide-only',
  'credentials-edit-hide-only',
  'credentials-delete-hide-only',
  'credentials-set-hiding',
  'credentials-reset'
])

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
  'The app’s role on the Host pipe is a claim the Host cannot verify against a program of the same user.'
]

export function createHostCredentials(d: { profileDir: string; platform?: NodeJS.Platform; now?: () => number; onChange?: (cmd: string) => void }): HostCredentials {
  const platform = d.platform ?? process.platform
  const now = d.now ?? Date.now
  let chain: Promise<unknown> = Promise.resolve()
  const queued = <T>(f: () => Promise<T>): Promise<T> => {
    const run = chain.then(f, f)
    chain = run.catch(() => {})
    return run
  }

  const entriesOf = async (f: CredentialsFile) => {
    const registry = await readExtensionRegistry(d.profileDir).catch(() => ({ version: 1 as const, entries: [] }))
    const mcp = await Promise.all(
      mcpSecretEntries(registry, f.mcpHide).map(async (e) => {
        const [last] = await queryCredentialUses(d.profileDir, { entryId: e.id, limit: 1 }, { now }).catch(() => [])
        return last ? { ...e, lastUsedAt: last.at } : e
      })
    )
    return [...f.entries, ...mcp]
  }

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

  const answer = async (cmd: string, args: Record<string, unknown>): Promise<CredentialsAnswer> => {
    switch (cmd) {
      case 'credentials-list': {
        const file = await readCredentials(d.profileDir)
        return { status: 200, body: { entries: await entriesOf(file), presets: PRESETS.map((p) => ({ id: p.id, label: p.label, measuredOn: p.measuredOn })) } }
      }
      case 'credentials-show': {
        const key = typeof args.id === 'string' ? args.id : null
        if (key === null) return bad('an id or a name is required')
        const entries = await entriesOf(await readCredentials(d.profileDir))
        const e = entries.find((x) => x.id === key || (x.kind === 'hide-only' ? x.alias === key : x.serverName === key))
        if (!e) return notFound(key)
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
          lines.push({ level: 'warn', text: `The list file cannot be used, so nothing is hidden: ${message(e)}` })
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
        lines.push({ level: 'ok', text: 'Never hidden: ASTERA_*, CLAUDE_*, CODEX_*, ANTHROPIC_*, OPENAI_* (the CLIs and Astera need them).' })
        for (const t of LIMITS) lines.push({ level: 'warn', text: t })
        if (platform === 'win32') lines.push({ level: 'warn', text: 'The Host’s Windows pipe keeps the default access list (Node cannot narrow it): any local program can connect.' })
        lines.push({ level: 'ok', text: 'A change counts for sessions started afterwards; a running session keeps its environment.' })
        return { status: 200, body: { lines } }
      }
      case 'credentials-add-hide-only': {
        const e = hideOnlyArgs(args)
        if ('status' in e) return e
        const entry: HideOnlyEntry = { kind: 'hide-only', id: newHideOnlyId(), ...e, createdAt: new Date(now()).toISOString() }
        return change((f) => ({ ...f, entries: [...f.entries, entry] }), () => ({ entry }))
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
        r = await answer(a.cmd, a.args)
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
