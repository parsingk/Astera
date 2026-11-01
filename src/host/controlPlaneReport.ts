// The Runtime report this Host answers `control-plane-report` with (remote governance design §5.2, §13): its Control
// Plane as names, states and counts, for this machine's app and CLI and for a person on a paired computer. Composed from
// the stores and the probes the Host already has, without starting a session: the spawner's Enforce blocker after a warm,
// the CLI version probe's cache, the sandbox kind per OS, the srt dependency check a sandboxed check's start makes, and
// the Codex Windows readiness Settings already asks. Each part is read in its own try, so one that fails is null (or no
// extensions) and logged, and the rest still answer. What a probe says in words (a path, srt's missing tools, a store's
// reason) stays in the Host log; only its code crosses (§5.3).
import { readAgentProfiles } from '../core/agentProfiles/store'
import { readAuditPolicy, STARTER_POLICY } from '../core/audit/policy'
import type { EnforceStart } from '../core/audit/enforce'
import { readCredentials } from '../core/credentials/store'
import { mcpSecretEntries } from '../core/credentials/mcpEntries'
import { readExtensionRegistry } from '../core/extensions/registry'
import { localReportExtensions } from '../core/controlPlane/local'
import type { ControlPlaneReport, PerProvider, ReportExtension } from '../core/controlPlane/report'
import { extensionPaths } from '../core/profile/paths'
import { providerOf } from '../core/providers/meta'
import { sandboxKindOf } from '../core/sandbox/coverage'
import type { Readiness } from '../core/sandbox/windowsReadiness'
import { openSecretStore, type SecretStore } from '../core/secrets/secretStore'
import type { CliVersionProbe } from '../core/sessions/cliVersion'
import type { FindingsReport } from '../core/findings/types'
import type { Account, Provider } from '../core/types'
import type { UpstreamState } from './gateway/upstream'

export interface ControlPlaneReportDeps {
  profileDir: string
  platform: NodeJS.Platform
  asteraVersion: string
  readAccounts(): Promise<Account[]>
  /** The app-wide "Run agents without permission checks" setting. */
  appBypass(): Promise<boolean>
  gatewayStates(): readonly UpstreamState[]
  /** The spawner's EnforceStart; absent on a Host with no spawner, and then, as when either method is absent, Enforce
   *  cannot be told and policy.enforce is null (ruling C12). */
  enforce?: Pick<EnforceStart, 'blocker' | 'warm'>
  cliVersions: Pick<CliVersionProbe, 'warm' | 'cached'>
  /** Ubuntu's AppArmor restriction on bubblewrap (the spawner's sandboxWarn), asked on Linux only. */
  claudeUsernsRestricted(): boolean
  /** Astera's check runner is built beside the Host's bundle. */
  checkRunner: boolean
  /** What srt lacks here, or null (SrtCheckRunner.missing, as a sandboxed Claude check's start asks it; ruling C5). Asked
   *  off Windows only; absent, that blocker is not told. */
  checkRunnerMissing?(): Promise<string | null>
  /** Windows only (index.ts sandboxReadiness): one Codex account's elevated sandbox setup. */
  codexReadiness?(account: Account): Promise<Readiness>
  findings?(): Promise<FindingsReport>
  /** Test injection; defaults to the profile's extension secret store, opened to read only. */
  secretStore?: Pick<SecretStore, 'read'>
  log(line: string): void
}

const PROVIDERS: readonly Provider[] = ['claude', 'codex']
const ENFORCE_PREFIX = 'ENFORCE_UNAVAILABLE: '
/** The parser's code word (report.ts): an error code such as SECRET_FILE_UNSAFE is made one by case and dashes. */
const CODE = /^[a-z][a-z0-9-]{0,63}$/

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The code of a blocker sentence: the first word after `ENFORCE_UNAVAILABLE: ` (`cli-too-old claude 2.0.0 2.1.306`). */
const blockerCode = (s: string | null): string | null => (s === null ? null : (s.startsWith(ENFORCE_PREFIX) ? s.slice(ENFORCE_PREFIX.length) : s).split(/\s/)[0])

/** A thrown error's code as a code word; one with no code, or none that can be made a word, is `failed`. */
function failureCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code
  if (typeof code !== 'string') return 'failed'
  const word = code.toLowerCase().replace(/_/g, '-')
  return CODE.test(word) ? word : 'failed'
}

export async function buildControlPlaneReport(d: ControlPlaneReportDeps): Promise<ControlPlaneReport> {
  const part = async <T>(name: string, read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read()
    } catch (e) {
      d.log(`control-plane-report: ${name} could not be read (${message(e)})`)
      return null
    }
  }
  // Read once for the profiles and the Codex readiness count; null when it could not be
  const accounts = await part('accounts', () => d.readAccounts())

  const enforce = async (): Promise<NonNullable<ControlPlaneReport['policy']>['enforce']> => {
    const e = d.enforce
    if (!e?.blocker || !e.warm) return null
    await Promise.all(PROVIDERS.map((p) => e.warm?.(p)))
    const of = (p: Provider): { terminal: string | null; chat: string | null } => ({
      terminal: blockerCode(e.blocker?.(p, 'terminal') ?? null),
      chat: blockerCode(e.blocker?.(p, 'chat') ?? null)
    })
    return { claude: of('claude'), codex: of('codex') }
  }
  const cliVersions = async (): Promise<PerProvider<string | null>> => {
    await Promise.all(PROVIDERS.map((p) => d.cliVersions.warm(p)))
    return { claude: d.cliVersions.cached('claude') ?? null, codex: d.cliVersions.cached('codex') ?? null }
  }

  const claudeBlocker = async (): Promise<string | null> => {
    if (d.platform === 'win32') return null
    if (!d.checkRunner) return 'no-check-runner'
    if (d.platform === 'linux' && d.claudeUsernsRestricted()) return 'userns-restricted'
    const missing = d.checkRunnerMissing ? await d.checkRunnerMissing() : null
    if (missing === null) return null
    d.log(`control-plane-report: the sandbox runtime cannot run a check here: ${missing}`)
    return 'runtime-missing'
  }
  const codexAccounts = async (): Promise<{ ready: number; total: number } | null> => {
    const readiness = d.codexReadiness
    if (d.platform !== 'win32' || !readiness || accounts === null) return null
    const codex = accounts.filter((a) => providerOf(a) === 'codex')
    const states = await Promise.all(codex.map((a) => readiness(a).catch((): Readiness => 'check-failed')))
    return { ready: states.filter((s) => s === 'ready').length, total: codex.length }
  }

  const secretStore = async (): Promise<ControlPlaneReport['secretStore']> => {
    const store = d.secretStore ?? openSecretStore({ dir: extensionPaths(d.profileDir).secrets, profileDir: d.profileDir })
    try {
      // `read` never creates anything: a store not made yet is null, and a pass
      await store.read('check')
      return { kind: 'owner-only-files', ok: true }
    } catch (e) {
      d.log(`control-plane-report: the secret store's check failed (${message(e)})`)
      return { kind: 'owner-only-files', ok: false, code: failureCode(e) }
    }
  }

  const [extensions, profiles, appBypass, policy, claudeSandboxBlocker, codexCount, credentials, store, findings] = await Promise.all([
    part('extensions', () => localReportExtensions(d.profileDir, d.gatewayStates())),
    part('profiles', async () => {
      if (accounts === null) throw new Error('the accounts could not be read')
      const there = new Set(accounts.map((a) => a.id))
      return (await readAgentProfiles(d.profileDir)).profiles.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        permission: p.permission,
        sandbox: p.sandbox,
        mcpExclude: [...p.mcpExclude],
        accountsThere: p.accountIds.filter((id) => there.has(id)).length,
        accountsNamed: p.accountIds.length
      }))
    }),
    part('appBypass', () => d.appBypass()),
    part('policy', async () => {
      // As policies-show answers it: no file is the starter rules in compatibility. A damaged copy is the policies
      // commands' to keep, as the findings read it
      const p = (await readAuditPolicy(d.profileDir, { keepDamaged: false })) ?? STARTER_POLICY
      const [enforced, versions] = await Promise.all([part('policy enforce', enforce), cliVersions()])
      return {
        mode: p.mode,
        otherwise: p.otherwise,
        rules: p.rules.length,
        ...(p.observingSince !== undefined ? { observingSince: p.observingSince } : {}),
        enforce: enforced,
        cliVersions: versions
      }
    }),
    part('sandbox claude', claudeBlocker),
    part('sandbox codexAccounts', codexAccounts),
    part('credentials', async () => {
      const [file, registry] = await Promise.all([readCredentials(d.profileDir), readExtensionRegistry(d.profileDir)])
      return {
        // A hide-only entry's projects are paths (§5.3): only whether it hides crosses
        hideOnly: file.entries.map((e) => ({ alias: e.alias, presets: [...e.presets], envNames: [...e.envNames], hidden: e.hide.on })),
        // The names a server's secrets go into, as ReportExtension.secretNames: never the store's own names
        mcp: mcpSecretEntries(registry, file.mcpHide).map((e) => ({
          serverId: e.serverId,
          serverName: e.serverName,
          names: [...e.envNames, ...e.protectedNames],
          hidden: e.hide.on
        }))
      }
    }),
    secretStore(),
    part('findings', async () => {
      if (!d.findings) return null
      const open = (await d.findings()).findings.filter((f) => !f.ignored)
      const byRule: Record<string, number> = {}
      for (const f of open) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1
      return { total: open.length, byRule }
    })
  ])

  const sandbox: ControlPlaneReport['sandbox'] = {
    claude: { kind: sandboxKindOf('claude', d.platform), blocker: claudeSandboxBlocker },
    // Codex's sandbox has no machine-wide blocker here: its Windows readiness is per account, counted below
    codex: { kind: sandboxKindOf('codex', d.platform), blocker: null }
  }
  if (codexCount !== null) sandbox.codexAccounts = codexCount
  return {
    version: 1,
    astera: { version: d.asteraVersion, platform: d.platform },
    extensions: extensions ?? ([] as ReportExtension[]),
    profiles,
    appBypass,
    policy,
    sandbox,
    credentials,
    secretStore: store,
    findings
  }
}
