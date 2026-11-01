// The Runtime report (remote governance design §5.2, §5.3): a Runtime's Control Plane as names, states and counts, read
// by a controller. Renderer-safe, so no `node:` import. The parser builds a new object from the fields it names, so a
// field a Runtime added (a `command`, `url`, `path`, an env value) never reaches the store or the screen, and a part
// that is too large is refused whole rather than cut.
import type { ExtensionKind } from '../extensions/types'
import type { Provider } from '../types'
import type { ProfilePermission } from '../agentProfiles/types'
import type { AuditMode } from '../audit/types'

/** The hello capability a Runtime that answers `control-plane-report` announces (§5.1). */
export const REPORT_CAPABILITY = 'control-plane.report'
/** Codes this build words; another code a newer Runtime sends is kept as its code word. */
export const ENFORCE_BLOCKER_CODES = ['cli-too-old', 'cli-version-unknown', 'cli-missing', 'hooks-off', 'codex-daemon'] as const
export const SANDBOX_BLOCKER_CODES = ['no-check-runner', 'userns-restricted', 'runtime-missing'] as const

export interface ReportExtension {
  id: string
  kind: ExtensionKind
  name: string
  enabled: boolean
  providers: Provider[]
  /** File kinds: compareHashOf (Task 1). Absent when the canonical copy could not be read. */
  compareHash?: string
  /** MCP: the env names whose value is a stored secret. Names only. */
  secretNames?: string[]
  /** MCP stdio: the Gateway's last state for it. Absent when the Gateway holds none. */
  gateway?: 'running' | 'stopped' | 'restarting' | 'failed'
}

export interface ReportProfile {
  id: string
  name: string
  status: 'active' | 'archived'
  permission: ProfilePermission
  sandbox: boolean
  mcpExclude: string[]
  /** How many of its accountIds exist there, and how many it names. */
  accountsThere: number
  accountsNamed: number
}

export interface PerProvider<T> {
  claude: T
  codex: T
}

/** `null` in a part = that part could not be read on the Runtime. */
export interface ControlPlaneReport {
  version: 1
  astera: { version: string; platform: string }
  extensions: ReportExtension[]
  profiles: ReportProfile[] | null
  /** "Run agents without permission checks" there. */
  appBypass: boolean | null
  policy: {
    mode: AuditMode
    otherwise: 'allow' | 'deny'
    rules: number
    observingSince?: string
    /** A blocker code (ENFORCE_BLOCKER_CODES or a newer one) per session kind, null when Enforce can start; the whole
     *  value null when this Host has no spawner to ask. */
    enforce: PerProvider<{ terminal: string | null; chat: string | null }> | null
    /** The CLI version found, null when it is not there or could not be read. */
    cliVersions: PerProvider<string | null>
  } | null
  sandbox: PerProvider<{ kind: 'sandbox' | 'deny-only'; blocker: string | null }> & {
    /** Windows only: Codex accounts whose elevated sandbox is set up, out of all Codex accounts. */
    codexAccounts?: { ready: number; total: number }
  }
  credentials: {
    hideOnly: Array<{ alias: string; presets: string[]; envNames: string[]; hidden: boolean }>
    mcp: Array<{ serverId: string; serverName: string; names: string[]; hidden: boolean }>
  } | null
  secretStore: { kind: 'owner-only-files'; ok: boolean; code?: string }
  /** Open findings there: total and per rule. */
  findings: { total: number; byRule: Record<string, number> } | null
}

const STRING_MAX = 256
const NAMES_MAX = 256
const EXTENSIONS_MAX = 2000
const PROFILES_MAX = 500
/** One credentials entry per hide-only alias or MCP server, so the extensions cap bounds both. */
const CREDENTIALS_MAX = EXTENSIONS_MAX
const RULES_MAX = 256
/** A blocker, secret store or findings rule code: the Host's command-word shape, so a newer one still reads as a word. */
const CODE = /^[a-z][a-z0-9-]{0,63}$/

const KINDS: readonly ExtensionKind[] = ['mcp', 'skill', 'command', 'agent']
const PROVIDER_NAMES: readonly Provider[] = ['claude', 'codex']
const GATEWAY_STATES = ['running', 'stopped', 'restarting', 'failed'] as const
const PERMISSIONS: readonly ProfilePermission[] = ['inherit', 'bypass', 'ask']
const MODES: readonly AuditMode[] = ['compatibility', 'observe', 'enforce']

/** Thrown inside the parser only, so each field check stays one line; the top level turns it into `{ error }`. */
class Refused extends Error {}
const refuse = (what: string): never => {
  throw new Refused(what)
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const obj = (v: unknown, what: string): Record<string, unknown> => (isObj(v) ? v : refuse(`${what} is not an object`))
const str = (v: unknown, what: string): string => (typeof v === 'string' && v.length <= STRING_MAX ? v : refuse(`${what} is not a short string`))
const bool = (v: unknown, what: string): boolean => (typeof v === 'boolean' ? v : refuse(`${what} is not a boolean`))
const count = (v: unknown, what: string): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : refuse(`${what} is not a count`))
const oneOf = <T extends string>(v: unknown, of: readonly T[], what: string): T => (of.includes(v as T) ? (v as T) : refuse(`${what} is not one this build knows`))
const code = (v: unknown, what: string): string => (typeof v === 'string' && CODE.test(v) ? v : refuse(`${what} is not a code`))
const codeOrNull = (v: unknown, what: string): string | null => (v === null ? null : code(v, what))
const list = (v: unknown, max: number, what: string): unknown[] => {
  if (!Array.isArray(v)) return refuse(`${what} is not a list`)
  return v.length <= max ? v : refuse(`${what} has more than ${max} entries`)
}
const names = (v: unknown, what: string): string[] => list(v, NAMES_MAX, what).map((n) => str(n, what))
const nullable = <T>(v: unknown, read: (v: unknown) => T): T | null => (v === null ? null : read(v))
const perProvider = <T>(v: unknown, what: string, read: (v: unknown, what: string) => T): PerProvider<T> => {
  const o = obj(v, what)
  return { claude: read(o.claude, `${what}.claude`), codex: read(o.codex, `${what}.codex`) }
}

/** null for a kind this build does not know: that entry is dropped, the rest kept (Review Focus 1). */
function extension(v: unknown): ReportExtension | null {
  const o = obj(v, 'an extension')
  if (typeof o.kind === 'string' && !KINDS.includes(o.kind as ExtensionKind)) return null
  const out: ReportExtension = {
    id: str(o.id, 'an extension id'),
    kind: oneOf(o.kind, KINDS, 'an extension kind'),
    name: str(o.name, 'an extension name'),
    enabled: bool(o.enabled, 'an extension enabled'),
    // A provider a newer build added is not one this build can show or compare, so it is left out of the list.
    providers: names(o.providers, 'an extension providers list').filter((p): p is Provider => PROVIDER_NAMES.includes(p as Provider))
  }
  if (o.compareHash !== undefined) out.compareHash = str(o.compareHash, 'an extension compare hash')
  if (o.secretNames !== undefined) out.secretNames = names(o.secretNames, 'an extension secret names list')
  if (o.gateway !== undefined) out.gateway = oneOf(o.gateway, GATEWAY_STATES, 'an extension gateway state')
  return out
}

function profile(v: unknown): ReportProfile {
  const o = obj(v, 'a profile')
  return {
    id: str(o.id, 'a profile id'),
    name: str(o.name, 'a profile name'),
    status: oneOf(o.status, ['active', 'archived'] as const, 'a profile status'),
    permission: oneOf(o.permission, PERMISSIONS, 'a profile permission'),
    sandbox: bool(o.sandbox, 'a profile sandbox'),
    mcpExclude: names(o.mcpExclude, 'a profile mcpExclude list'),
    accountsThere: count(o.accountsThere, 'a profile accountsThere'),
    accountsNamed: count(o.accountsNamed, 'a profile accountsNamed')
  }
}

function policy(v: unknown): NonNullable<ControlPlaneReport['policy']> {
  const o = obj(v, 'policy')
  const out: NonNullable<ControlPlaneReport['policy']> = {
    mode: oneOf(o.mode, MODES, 'policy mode'),
    otherwise: oneOf(o.otherwise, ['allow', 'deny'] as const, 'policy otherwise'),
    rules: count(o.rules, 'policy rules'),
    enforce: nullable(o.enforce, (e) =>
      perProvider(e, 'policy enforce', (p, what) => {
        const kinds = obj(p, what)
        return { terminal: codeOrNull(kinds.terminal, `${what}.terminal`), chat: codeOrNull(kinds.chat, `${what}.chat`) }
      })
    ),
    cliVersions: perProvider(o.cliVersions, 'policy cliVersions', (c, what) => nullable(c, (s) => str(s, what)))
  }
  if (o.observingSince !== undefined) out.observingSince = str(o.observingSince, 'policy observingSince')
  return out
}

function sandbox(v: unknown): ControlPlaneReport['sandbox'] {
  const o = obj(v, 'sandbox')
  const out: ControlPlaneReport['sandbox'] = perProvider(o, 'sandbox', (p, what) => {
    const s = obj(p, what)
    return { kind: oneOf(s.kind, ['sandbox', 'deny-only'] as const, `${what}.kind`), blocker: codeOrNull(s.blocker, `${what}.blocker`) }
  })
  if (o.codexAccounts !== undefined) {
    const a = obj(o.codexAccounts, 'sandbox codexAccounts')
    out.codexAccounts = { ready: count(a.ready, 'sandbox codexAccounts.ready'), total: count(a.total, 'sandbox codexAccounts.total') }
  }
  return out
}

function credentials(v: unknown): NonNullable<ControlPlaneReport['credentials']> {
  const o = obj(v, 'credentials')
  return {
    hideOnly: list(o.hideOnly, CREDENTIALS_MAX, 'credentials hideOnly').map((e) => {
      const h = obj(e, 'a hide-only entry')
      return {
        alias: str(h.alias, 'a hide-only alias'),
        presets: names(h.presets, 'a hide-only presets list'),
        envNames: names(h.envNames, 'a hide-only envNames list'),
        hidden: bool(h.hidden, 'a hide-only hidden')
      }
    }),
    mcp: list(o.mcp, CREDENTIALS_MAX, 'credentials mcp').map((e) => {
      const m = obj(e, 'an MCP credentials entry')
      return {
        serverId: str(m.serverId, 'an MCP credentials serverId'),
        serverName: str(m.serverName, 'an MCP credentials serverName'),
        names: names(m.names, 'an MCP credentials names list'),
        hidden: bool(m.hidden, 'an MCP credentials hidden')
      }
    })
  }
}

function secretStore(v: unknown): ControlPlaneReport['secretStore'] {
  const o = obj(v, 'secretStore')
  const out: ControlPlaneReport['secretStore'] = { kind: oneOf(o.kind, ['owner-only-files'] as const, 'secretStore kind'), ok: bool(o.ok, 'secretStore ok') }
  if (o.code !== undefined) out.code = code(o.code, 'secretStore code')
  return out
}

function findings(v: unknown): NonNullable<ControlPlaneReport['findings']> {
  const o = obj(v, 'findings')
  const by = obj(o.byRule, 'findings byRule')
  const keys = Object.keys(by)
  if (keys.length > RULES_MAX) refuse(`findings byRule has more than ${RULES_MAX} rules`)
  const byRule: Record<string, number> = {}
  for (const k of keys) byRule[code(k, 'a findings rule')] = count(by[k], 'a findings rule count')
  return { total: count(o.total, 'findings total'), byRule }
}

/** The controller's only way to read a report a Runtime sent: anything else in it is dropped, and any wrong type or
 *  oversize part refuses the whole report (design §5.3). */
export function parseControlPlaneReport(v: unknown): ControlPlaneReport | { error: string } {
  try {
    const o = obj(v, 'the report')
    if (o.version !== 1) refuse('the report is not version 1')
    const astera = obj(o.astera, 'astera')
    const extensions: ReportExtension[] = []
    for (const e of list(o.extensions, EXTENSIONS_MAX, 'extensions')) {
      const ok = extension(e)
      if (ok) extensions.push(ok)
    }
    return {
      version: 1,
      astera: { version: str(astera.version, 'astera version'), platform: str(astera.platform, 'astera platform') },
      extensions,
      profiles: nullable(o.profiles, (p) => list(p, PROFILES_MAX, 'profiles').map(profile)),
      appBypass: nullable(o.appBypass, (b) => bool(b, 'appBypass')),
      policy: nullable(o.policy, policy),
      sandbox: sandbox(o.sandbox),
      credentials: nullable(o.credentials, credentials),
      secretStore: secretStore(o.secretStore),
      findings: nullable(o.findings, findings)
    }
  } catch (err) {
    if (err instanceof Refused) return { error: err.message }
    throw err
  }
}
