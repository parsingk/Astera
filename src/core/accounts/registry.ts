import { promises as fs } from 'node:fs'
import path from 'node:path'
import { comparablePath } from '../files/tree'
import { randomUUID } from 'node:crypto'
import type { Account, Provider } from '../types'
import { isProvider, providerOf } from '../providers/meta'
import { makeDescriptors, type ProviderDescriptor } from '../providers/descriptor'
import { DEFAULT_ACCOUNT_PLACEHOLDER_LABEL } from './detect'
import { nextAccountColor } from './colors'
import { isLoggedIn } from './loginCheck'
import { keepDamaged, readStoreFile, StoreUnread } from '../storeFile'
import { renameRetrying } from '../renameRetry'

// Paths compare through comparablePath (core/files/tree.ts): case folded on win32 and darwin, exact on linux.

function slugify(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'account'
}

/** Exported for accountsFile.ts, the Host's read-only look at this same file — one rule for which
 *  file is corrupt. */
export function isValidAccount(a: unknown): a is Account {
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
    // A file that could not be read is not damaged (audit U-1): it was taken for damage, the list started empty, and the
    // next add wrote a list of one over every account. It is marked unread, and the next change reads it again first.
    const read = await readStoreFile(this.filePath)
    if (read.kind === 'unreadable') {
      this.unread = read.error
      return { recovered: false }
    }
    this.unread = null
    try {
      if (read.kind === 'missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      const parsed = JSON.parse(read.text)
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
      // Colours were once handed out by counting accounts, which repeated one whenever an account was
      // removed, so a file written back then can hold the same colour twice. Nothing else would ever fix
      // it: a colour is only chosen when an account is added, and these accounts already have one.
      // The write is swallowed on purpose. Reaching the catch below would read a failed save as a corrupt
      // file and empty the account list over a cosmetic repair; the fix stands in memory either way, and
      // the next save() carries it to disk.
      if (this.resolveColorCollisions()) await this.save().catch(() => {})
      return { recovered: false }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.accounts = []
        this.dismissed = []
        return { recovered: false }
      }
      // Preserve the corrupt copy, then start from an empty list. The exclusions go with it on purpose:
      // with no accounts left, detection finding those directories again is the way back. The bytes read, never
      // over an earlier copy (audit U-1).
      if (read.kind === 'text') await keepDamaged(this.filePath, read.text)
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

  /** What load could not read, kept until a change reads the file again (audit U-1); null when it was read. */
  private unread: unknown = null

  /** Before a change over a file load could not read: reads it again, and refuses the change when it still cannot. */
  private ensureRead(): Promise<void> {
    if (this.unread === null) return Promise.resolve()
    // One re-read for every change waiting on it (final review I-6).
    this.recovering ??= (async () => {
      await this.load()
      if (this.unread !== null) throw new StoreUnread(this.filePath, this.unread)
    })().finally(() => {
      this.recovering = null
    })
    return this.recovering
  }
  private recovering: Promise<void> | null = null

  /** Changes one after another (final review M-5): each takes its rollback snapshot when it starts, so one failing
   *  never rolls back the change made beside it. */
  private changeQueue: Promise<unknown> = Promise.resolve()

  /** Runs a change, and puts memory back when its save fails (audit U-12): the account stayed in the list though the
   *  file never got it, and adding it again made a second folder. */
  private changing<T>(change: () => T): Promise<T> {
    const run = async (): Promise<T> => {
      const before = { accounts: this.accounts.map((a) => ({ ...a })), dismissed: [...this.dismissed] }
      const out = change()
      try {
        await this.save()
      } catch (e) {
        this.accounts = before.accounts
        this.dismissed = before.dismissed
        throw e
      }
      return out
    }
    const next = this.changeQueue.then(run, run)
    this.changeQueue = next.catch(() => undefined)
    return next
  }

  async create(input: { label: string; color?: string; provider?: Provider }): Promise<Account> {
    await this.ensureRead()
    const provider = providerOf(input)
    const root = this.roots[provider]
    const configDir = await this.uniqueDir(root, slugify(input.label))
    await fs.mkdir(configDir, { recursive: true })
    return this.add(input.label, configDir, provider, input.color)
  }

  async import(input: { label: string; configDir: string; provider?: Provider }): Promise<Account> {
    await this.ensureRead()
    const stat = await fs.stat(input.configDir) // throws when it is missing
    if (!stat.isDirectory()) throw new Error(`not a directory: ${input.configDir}`)
    // A folder already registered is that account, not a second one. Checked after the await and right
    // before `add` pushes (no await in between), so two imports of one folder racing each other (the
    // auto-detect dialog confirmed twice) still register it once.
    const norm = comparablePath(input.configDir)
    const existing = this.accounts.find((a) => comparablePath(a.configDir) === norm)
    if (existing) return existing
    return this.add(input.label, input.configDir, providerOf(input))
  }

  async remove(id: string): Promise<void> {
    await this.ensureRead()
    const account = this.get(id) // verifies it exists
    await this.changing(() => {
      this.accounts = this.accounts.filter((a) => a.id !== id)
      const norm = comparablePath(account.configDir)
      if (!this.dismissed.some((d) => comparablePath(d) === norm)) this.dismissed.push(account.configDir)
    })
  }

  /** Gives a fresh colour to every account whose colour an earlier one already holds, and answers whether
   *  it changed anything. The earlier account keeps what it has: accounts.json is in registration order,
   *  so the account that has worn the colour longest is the one that keeps it. */
  private resolveColorCollisions(): boolean {
    const seen = new Set<string>()
    let changed = false
    for (const account of this.accounts) {
      if (seen.has(account.color.trim().toLowerCase())) {
        account.color = nextAccountColor(seen)
        changed = true
      }
      seen.add(account.color.trim().toLowerCase())
    }
    return changed
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
    // A repair waits for a file it could read (final review I-5): thrown here, at start-up, the app never opened.
    try {
      await this.ensureRead()
    } catch {
      return
    }
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
    // Keychain, codex is auth.json. accounts/loginStatus.ts owns that branching; loginCheck.ts is the
    // one rule the Host's spawner and checks share with this (C8).
    return isLoggedIn(account, this.descriptors)
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
      color: color ?? nextAccountColor(this.accounts.map((a) => a.color)),
      createdAt: new Date().toISOString()
    }
    return this.changing(() => {
      // Asked again inside the queue (final review M-5): two imports of one folder in flight register it once.
      const norm = comparablePath(configDir)
      const existing = this.accounts.find((a) => comparablePath(a.configDir) === norm)
      if (existing) return existing
      this.accounts.push(account)
      // Registering this directory again overrides the earlier unregister — a registered account must never
      // sit in the exclusion list, or re-adding it by hand would leave detection permanently blind to it
      this.dismissed = this.dismissed.filter((d) => comparablePath(d) !== comparablePath(configDir))
      return account
    })
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

  private saves = 0
  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    // Its own temp file and the rename retried (audit U-12): the Host reads accounts.json at every spawn, and on win32
    // a rename over a file being read is refused for that moment.
    const tmp = `${this.filePath}.${process.pid}.${++this.saves}.tmp`
    await fs.writeFile(
      tmp,
      JSON.stringify({ version: 1, accounts: this.accounts, dismissedDirs: this.dismissed }, null, 2),
      'utf8'
    )
    try {
      await renameRetrying(tmp, this.filePath)
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw e
    }
    this.onChanged?.(this.list())
  }
}
