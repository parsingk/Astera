// `astera skills list` and `astera skills install` — answered in the CLI process, like `help`.
//
// **Why no Host and no app.** Everything these two need is a file in the profile: accounts.json says
// which accounts exist and where their config folders are, app-settings.json says which skills the
// person has switched on, and the stubs ship with the build. Asking the Host would add a process to
// a command that only reads files and writes stub files into config folders, and the case this
// exists for (an account added in the app gets no skills until the app restarts, ipc.ts bootOrch)
// is one where a shell is the natural place to fix it.
//
// **The same list and the same rules as the app.** Which skills exist and what gates each is
// `skillStubs`, which the app's own install builds from; what counts as ours is `installStub`'s
// ownership rule, and `list` reports with `stubStateOf`, the rule `install` acts on. The settings
// are read by the app's own store, so its narrowing and its defaults are the ones used here.
//
// **It removes nothing.** A skill whose setting is off is not uninstalled (that is deleting a file
// on a guess about the person's intent), and the stub under the pre-rebrand name is left for the
// app's launch to clean up (`keepLegacy`).
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CliError } from '../core/orchestration/cliOutput'
import type { Account, Provider } from '../core/types'
import { providerOf } from '../core/providers/meta'
import { readAccountEntries } from '../core/accounts/accountsFile'
import { AppSettingsStore } from '../main/appSettingsStore'
import {
  installStub,
  skillStubs,
  stubStateOf,
  stubTargetPath,
  type StubState
} from '../main/orchestration/stub'

/** One skill in `skills list`. */
export interface SkillListed {
  name: string
  /** Whether the current settings install it. */
  enabled: boolean
  installed: StubState
}

/** What `skills install` did with one skill in one account. `failed` is a write or read that threw;
 *  the reason is on stderr. */
export type SkillInstallResult = 'written' | 'unchanged' | 'skipped-not-ours' | 'failed'

export interface SkillInstalled {
  name: string
  result: SkillInstallResult
}

/** A skill `skills install` left out because its setting is off, and where that setting is. */
export interface SkillNotEnabled {
  name: string
  setting: string
}

export interface SkillsAccount {
  id: string
  label: string
  provider: Provider
  skills: SkillListed[] | SkillInstalled[]
}

/** Said on every install, because it is the question that follows one (design R2.5). */
export const SKILLS_NOTE = 'Sessions already open do not pick up new skills; open a new session to use them.'

/**
 * Where the stub sources are: `<resourcesPath>/skills` in a packaged build (electron-builder's
 * extraResources), else the repo's `resources/skills` two levels above `out/main/cli.js` — the
 * same two places the app's bootOrch picks between with `app.isPackaged`, which this process
 * cannot ask. In development `resourcesPath` is Electron's own folder, which has no skills, so the
 * test is whether the orchestration stub is there. `undefined` when neither has it.
 */
export function resolveSkillsDir(a: {
  resourcesPath: string | undefined
  cliEntry: string
  exists: (p: string) => boolean
}): string | undefined {
  const candidates = [
    ...(a.resourcesPath ? [path.join(a.resourcesPath, 'skills')] : []),
    path.resolve(path.dirname(a.cliEntry), '..', '..', 'resources', 'skills')
  ]
  return candidates.find((d) => a.exists(path.join(d, 'orchestration-stub.md')))
}

type Outcome = { ok: true; body: Record<string, unknown> } | { ok: false; error: CliError }

export async function skillsCommand(a: {
  cmd: 'skills-list' | 'skills-install'
  args: Record<string, unknown>
  profileDir: string
  skillsDir: string
  log?: (message: string) => void
}): Promise<Outcome> {
  const wanted = a.args.account
  if (wanted !== undefined && (typeof wanted !== 'string' || wanted === ''))
    return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: '--account needs an id' } }

  let accounts: Account[]
  try {
    accounts = await readAccountEntries(path.join(a.profileDir, 'accounts.json'))
  } catch (err) {
    // The same refusal the Host gives for this file (6): answering "no accounts" would make every
    // --account a false 404, and repairing it is the app's job.
    return { ok: false, error: { code: 'CONFLICT', message: err instanceof Error ? err.message : String(err) } }
  }
  if (typeof wanted === 'string') {
    accounts = accounts.filter((x) => x.id === wanted)
    if (accounts.length === 0) return { ok: false, error: { code: 'NOT_FOUND', message: `unknown account: ${wanted}` } }
  }

  const settings = new AppSettingsStore(path.join(a.profileDir, 'app-settings.json'))
  await settings.load()
  const stubs = skillStubs(a.skillsDir, {
    workUnitTrackingEnabled: settings.getWorkUnitTrackingEnabled(),
    agentBrowserEnabled: settings.getAgentBrowserEnabled(),
    resumeStrategy: settings.getResumeStrategy()
  })
  const head = (x: Account): Omit<SkillsAccount, 'skills'> => ({ id: x.id, label: x.label, provider: providerOf(x) })

  if (a.cmd === 'skills-list') {
    const sources = new Map<string, string | null>()
    for (const s of stubs) sources.set(s.skillName, await fs.readFile(s.stubPath, 'utf8').catch(() => null))
    const rows: SkillsAccount[] = []
    for (const x of accounts) {
      const skills: SkillListed[] = []
      for (const s of stubs) {
        const source = sources.get(s.skillName) ?? null
        const existing = await fs.readFile(stubTargetPath(x.configDir, s.skillName), 'utf8').catch(() => null)
        // A source this build cannot read has nothing to compare with: what is there is either
        // nothing or somebody's file, and calling it ours would be a guess.
        const installed: StubState =
          source === null ? (existing === null ? 'missing' : 'not-ours') : stubStateOf(existing, source)
        skills.push({ name: s.skillName, enabled: s.enabled, installed })
      }
      rows.push({ ...head(x), skills })
    }
    return { ok: true, body: { accounts: rows } }
  }

  const enabled = stubs.filter((s) => s.enabled)
  const r = await installStub({
    stubs: enabled,
    configDirs: accounts.map((x) => x.configDir),
    keepLegacy: true,
    log: a.log
  })
  const resultOf = (target: string): SkillInstallResult =>
    r.written.includes(target)
      ? 'written'
      : r.unchanged.includes(target)
        ? 'unchanged'
        : r.skipped.includes(target)
          ? 'skipped-not-ours'
          : // In `failed`, or absent because installStub skipped the source (unreadable, or no
            // ownership marker) — either way nothing is in place for it, and the log says why.
            'failed'
  const rows: SkillsAccount[] = accounts.map((x) => ({
    ...head(x),
    skills: enabled.map((s) => ({ name: s.skillName, result: resultOf(stubTargetPath(x.configDir, s.skillName)) }))
  }))
  const notEnabled: SkillNotEnabled[] = stubs
    .filter((s) => !s.enabled)
    .map((s) => ({ name: s.skillName, setting: s.setting ?? '' }))
  return { ok: true, body: { accounts: rows, notEnabled, note: SKILLS_NOTE } }
}
