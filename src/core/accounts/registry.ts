import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Account, Provider } from '../types'
import { isProvider, providerOf } from '../providers/meta'
import { descriptorOf, makeDescriptors, type ProviderDescriptor } from '../providers/descriptor'
import { DEFAULT_ACCOUNT_PLACEHOLDER_LABEL } from './detect'

const COLORS = ['#4f9cf9', '#f97316', '#22c55e', '#e879f9', '#facc15', '#ef4444']

/** Same rule as detect.ts's own normalize (and descriptor.ts's normalizePath) — kept local because those
 *  are too, and it must stay in step with them: detect.ts is what compares these paths for the exclusion.
 *  Used here only to keep dismissedDirs free of case-variant duplicates. */
const normalizeDir = (p: string): string => path.resolve(p).toLowerCase()

function slugify(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'account'
}

function isValidAccount(a: unknown): a is Account {
  if (a === null || typeof a !== 'object') return false
  const o = a as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    o.id !== '' &&
    typeof o.label === 'string' &&
    o.label !== '' &&
    typeof o.configDir === 'string' &&
    o.configDir !== '' &&
    typeof o.color === 'string' &&
    o.color !== '' &&
    typeof o.createdAt === 'string' &&
    o.createdAt !== '' &&
    (o.provider === undefined || isProvider(o.provider))
  )
}

export class AccountRegistry {
  private accounts: Account[] = []
  /** configDirs the user unregistered. Auto-detection excludes them so an account the user just removed
   *  does not come straight back as a suggestion — remove() leaves the directory on disk (the CLI's own
   *  settings and transcripts live there), and detect()'s marker check passes on settings.json or
   *  projects/ alone, so the exclusion cannot come from the filesystem. It has to be remembered.
   *  Deliberately not derived as "any unregistered dir under the accounts root": when accounts.json is
   *  corrupt, load() starts from an empty list, and detection finding those dirs again is the recovery
   *  path back. Only an explicit unregister excludes. */
  private dismissed: string[] = []
  onChanged?: (accounts: Account[]) => void
  private roots: Record<Provider, string>
  private descriptors: Record<Provider, ProviderDescriptor> = makeDescriptors(process.platform)

  constructor(
    private filePath: string,
    accountsRoot: string,
    // When unspecified, the sibling '.codex-accounts' of the claude root — the real wiring (core.ts) always passes it explicitly
    codexAccountsRoot: string = path.join(path.dirname(accountsRoot), '.codex-accounts')
  ) {
    // The per-provider roots are assembled once — that is what removes the binary branch from create() below.
    // Why absolute paths are not baked into the descriptor: tests pass in temporary directories.
    this.roots = { claude: accountsRoot, codex: codexAccountsRoot }
  }

  async load(): Promise<{ recovered: boolean }> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
      // If even one element is missing a required field such as configDir, a spawn could go out with
      // CLAUDE_CONFIG_DIR=undefined and contaminate an account, so a single misshaped element makes the whole
      // file corrupt.
      if (!Array.isArray(parsed.accounts) || !parsed.accounts.every(isValidAccount)) {
        throw new Error('invalid schema')
      }
      this.accounts = parsed.accounts
      // Absent in files written before this field existed. A malformed value only costs the user a
      // re-suggested account, so bad entries are filtered rather than failing the whole file the way a
      // misshaped account does — accounts carry configDir, which a spawn would act on.
      this.dismissed = Array.isArray(parsed.dismissedDirs)
        ? parsed.dismissedDirs.filter((d: unknown): d is string => typeof d === 'string')
        : []
      return { recovered: false }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.accounts = []
        this.dismissed = []
        return { recovered: false }
      }
      // Preserve the corrupt copy, then start from an empty list. The exclusions go with it on purpose:
      // with no accounts left, detection finding those directories again is the way back.
      await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
      this.accounts = []
      this.dismissed = []
      return { recovered: true }
    }
  }

  list(): Account[] {
    return [...this.accounts]
  }

  get(id: string): Account {
    const account = this.accounts.find((a) => a.id === id)
    if (!account) throw new Error(`unknown account: ${id}`)
    return account
  }

  async create(input: { label: string; color?: string; provider?: Provider }): Promise<Account> {
    const provider = providerOf(input)
    const root = this.roots[provider]
    const configDir = await this.uniqueDir(root, slugify(input.label))
    await fs.mkdir(configDir, { recursive: true })
    return this.add(input.label, configDir, provider, input.color)
  }

  async import(input: { label: string; configDir: string; provider?: Provider }): Promise<Account> {
    const stat = await fs.stat(input.configDir) // throws when it is missing
    if (!stat.isDirectory()) throw new Error(`not a directory: ${input.configDir}`)
    return this.add(input.label, input.configDir, providerOf(input))
  }

  async remove(id: string): Promise<void> {
    const account = this.get(id) // verifies it exists
    this.accounts = this.accounts.filter((a) => a.id !== id)
    const norm = normalizeDir(account.configDir)
    if (!this.dismissed.some((d) => normalizeDir(d) === norm)) this.dismissed.push(account.configDir)
    await this.save()
  }

  /** The unregistered configDirs, for detection to exclude. Raw paths — detect.ts normalizes them itself. */
  dismissedDirs(): string[] {
    return [...this.dismissed]
  }

  /**
   * For accounts whose label is the placeholder ('Default account') only, replaces the label with a readable
   * email if there is one.
   * Labels the user chose themselves are not touched (only the placeholder string matches). Once the email is
   * the label it is no longer the placeholder, so calling again changes nothing (idempotent).
   * A one-shot sync at load time to fix default accounts registered back when the email could not be read,
   * which got stuck with the placeholder.
   */
  async syncPlaceholderLabels(
    resolveEmail: (account: Account) => Promise<string | null>
  ): Promise<void> {
    let changed = false
    for (const account of this.accounts) {
      if (account.label !== DEFAULT_ACCOUNT_PLACEHOLDER_LABEL) continue
      const email = await resolveEmail(account)
      if (email) {
        account.label = email
        changed = true
      }
    }
    if (changed) await this.save()
  }

  async loginStatus(id: string): Promise<boolean> {
    const account = this.get(id)
    // The evidence differs per provider and platform — claude is .credentials.json or macOS
    // Keychain, codex is auth.json. accounts/loginStatus.ts owns that branching.
    return descriptorOf(this.descriptors, account).isLoggedIn(account.configDir)
  }

  private async add(
    label: string,
    configDir: string,
    provider: Provider,
    color?: string
  ): Promise<Account> {
    const account: Account = {
      id: randomUUID(),
      label,
      configDir,
      provider,
      color: color ?? COLORS[this.accounts.length % COLORS.length],
      createdAt: new Date().toISOString()
    }
    this.accounts.push(account)
    // Registering this directory again overrides the earlier unregister — a registered account must never
    // sit in the exclusion list, or re-adding it by hand would leave detection permanently blind to it
    this.dismissed = this.dismissed.filter((d) => normalizeDir(d) !== normalizeDir(configDir))
    await this.save()
    return account
  }

  private async uniqueDir(root: string, slug: string): Promise<string> {
    for (let n = 0; ; n++) {
      const dir = path.join(root, n === 0 ? slug : `${slug}-${n + 1}`)
      try {
        await fs.access(dir)
      } catch {
        return dir
      }
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = this.filePath + '.tmp'
    await fs.writeFile(
      tmp,
      JSON.stringify({ version: 1, accounts: this.accounts, dismissedDirs: this.dismissed }, null, 2),
      'utf8'
    )
    await fs.rename(tmp, this.filePath)
    this.onChanged?.(this.list())
  }
}
