// Keeping the Credentials list's keys and logins out of agent sessions (credentials design §5). The session managers ask
// `HidingSource.get(cwd)` while they build a session's environment, before Astera adds its own variables, so nothing an
// entry names can take away the session's identity, its Gateway token or a value a shared server is given.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { isPathWithin } from '../files/tree'
import { extensionPaths, profilePaths } from '../profile/paths'
import type { ExtensionRegistry } from '../extensions/types'
import { mcpSecretEntries } from './mcpEntries'
import { PRESETS } from './presets'
import { isNeverHidden, parseCredentials } from './store'
import type { CredentialEntry, CredentialsFile, Hiding } from './types'

export interface HidingChange {
  /** Variable names the session's environment loses. */
  remove: string[]
  /** Variables pointed at an empty Astera-owned folder or file (a hidden CLI login's configuration). */
  set: Record<string, string>
}

const applies = (hide: Hiding, project: string): boolean =>
  hide.on && (hide.projects === undefined || hide.projects.some((p) => isPathWithin(p, project)))

/** What the entries that hide take out of a session started in `cwd`. Protected names are dropped again here, whatever an
 *  entry says. */
export function hidingFor(a: { entries: CredentialEntry[]; cwd: string; projectOf: (cwd: string) => string; emptyDir: string }): HidingChange {
  const project = a.projectOf(a.cwd)
  const remove: string[] = []
  const set: Record<string, string> = {}
  const add = (n: string): void => {
    if (!isNeverHidden(n) && !remove.includes(n)) remove.push(n)
  }
  for (const e of a.entries) {
    if (!applies(e.hide, project)) continue
    for (const n of e.envNames) add(n)
    if (e.kind !== 'hide-only') continue
    for (const id of e.presets) {
      const p = PRESETS.find((x) => x.id === id)
      if (!p) continue
      for (const n of p.remove) add(n)
      for (const [name, kind] of Object.entries(p.redirect)) {
        if (isNeverHidden(name)) continue
        set[name] = kind === 'empty-dir' ? path.join(a.emptyDir, p.id) : path.join(a.emptyDir, p.id, name)
      }
    }
  }
  return { remove, set }
}

/** Takes the change into `env`: names removed case-insensitively on win32 (Windows variables are), exactly elsewhere; each
 *  redirect's empty folder or file made when it is not there yet. */
export function applyHiding(env: Record<string, string | undefined>, h: HidingChange, platform: NodeJS.Platform): void {
  const sameName = sameNameOn(platform)
  const drop = (name: string): void => {
    for (const k of Object.keys(env)) if (sameName(k, name)) delete env[k]
  }
  for (const n of h.remove) drop(n)
  for (const [name, target] of Object.entries(h.set)) {
    drop(name)
    if (path.basename(target) === name) {
      mkdirSync(path.dirname(target), { recursive: true })
      if (!existsSync(target)) writeFileSync(target, '')
    } else mkdirSync(target, { recursive: true })
    env[name] = target
  }
}

/** Whether two variable names are one: whatever their case on win32 (Windows variables are), exactly elsewhere. */
const sameNameOn =
  (platform: NodeJS.Platform) =>
  (a: string, b: string): boolean =>
    platform === 'win32' ? a.toUpperCase() === b.toUpperCase() : a === b

/** What a process started from `env` goes without once `h` is applied (applyHiding), by the names the list gives: those
 *  of `h.remove` that `env` holds, then every redirected one, whose value the person's own no longer is. Names only, never
 *  values (Task K fix round 2: a check's result says them). */
export function hiddenNames(env: Record<string, string | undefined>, h: HidingChange, platform: NodeJS.Platform): string[] {
  const sameName = sameNameOn(platform)
  const held = (name: string): boolean => Object.keys(env).some((k) => env[k] !== undefined && sameName(k, name))
  return [...new Set([...h.remove.filter(held), ...Object.keys(h.set)])]
}

/** A worker's folder is a worktree outside its project: the worktree registry says which project it belongs to. */
export function projectOfWorktrees(list: () => readonly { path: string; repoPath: string }[]): (cwd: string) => string {
  return (cwd) => list().find((w) => isPathWithin(w.path, cwd))?.repoPath ?? cwd
}

export interface HidingSource {
  /** What a session started in `cwd` loses. `sessionId` names its own empty locations (one nobody shares without it). */
  get(cwd: string, sessionId?: string): HidingChange
  /** The list file is damaged: the registered entries are not hidden until it is repaired (Settings and `doctor` say
   *  so); the shared servers' keys keep their default. */
  damaged(): boolean
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const EMPTY_LIST: CredentialsFile = { version: 1, entries: [], mcpHide: {} }
/** How long a session's empty locations are kept after it last started (the records' own 30 days). */
const KEEP_EMPTY_MS = 30 * 24 * 60 * 60 * 1000
const SWEEP_EVERY_MS = 60 * 60 * 1000

/** Reads the list and the shared MCP servers at every call, so a change counts for the next session whichever process
 *  starts it. Both are small files read once per spawn. Never throws. A damaged list hides only the shared servers' keys
 *  by their default (C7, final review M2); a list that cannot be read for a moment is the last one read (final review
 *  M1). Each session gets empty locations of its own, the same ones each time it starts again, so a login made inside it
 *  stays its own (final review I3); those of a session not started for 30 days are removed. */
export function createHidingSource(a: {
  profileDir: string
  projectOf: (cwd: string) => string
  now?: () => number
  log?: (m: string) => void
}): HidingSource {
  const now = a.now ?? Date.now
  const emptyRoot = profilePaths(a.profileDir).credentialEmpty
  let damaged = false
  /** The last list read, for a moment the file cannot be read. */
  let last: CredentialsFile = EMPTY_LIST
  const readList = (): CredentialsFile | null => {
    let text: string
    try {
      text = readFileSync(profilePaths(a.profileDir).credentials, 'utf8')
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return (last = EMPTY_LIST)
      a.log?.(`credentials.json could not be read (${String(e)}); this session is hidden by the list as last read`)
      return last
    }
    const f = parseCredentials(text)
    if (f !== null) last = f
    return f
  }
  let sweptAt = -Infinity
  const sweep = (t: number): void => {
    if (t - sweptAt < SWEEP_EVERY_MS) return
    sweptAt = t
    let names: string[]
    try {
      names = readdirSync(emptyRoot)
    } catch {
      return
    }
    for (const n of names) {
      const p = path.join(emptyRoot, n)
      try {
        const st = statSync(p)
        if (!st.isDirectory() || t - st.mtimeMs < KEEP_EMPTY_MS) continue
        rmSync(p, { recursive: true, force: true })
        a.log?.(`credentials: removed ${p}, the CLI login locations of a session not started for 30 days`)
      } catch (e) {
        a.log?.(`credentials: could not remove ${p}: ${String(e)}`)
      }
    }
  }
  /** A session's own folder of empty locations; a spawn with no session id gets one nobody else has. */
  const rootOf = (sessionId: string | undefined): string =>
    path.join(emptyRoot, sessionId === undefined ? `once-${randomBytes(6).toString('hex')}` : sessionId.replace(/[^A-Za-z0-9_-]/g, '_'))
  const readRegistry = (): ExtensionRegistry => {
    try {
      const v: unknown = JSON.parse(readFileSync(extensionPaths(a.profileDir).registry, 'utf8'))
      return isRecord(v) && v.version === 1 && Array.isArray(v.entries) ? (v as unknown as ExtensionRegistry) : { version: 1, entries: [] }
    } catch {
      return { version: 1, entries: [] }
    }
  }
  return {
    get(cwd, sessionId) {
      const list = readList()
      damaged = list === null
      let shared: CredentialEntry[] = []
      try {
        shared = mcpSecretEntries(readRegistry(), list?.mcpHide ?? {})
      } catch {
        // A registry Astera did not write in this shape: its servers' variables are not hidden, the spawn goes on
      }
      // A damaged list holds the person's own switches: none of them is guessed, the shared servers keep their default
      const entries: CredentialEntry[] = list === null ? shared : [...list.entries, ...shared]
      const t = now()
      sweep(t)
      const root = rootOf(sessionId)
      const change = hidingFor({ entries, cwd, projectOf: a.projectOf, emptyDir: root })
      if (Object.keys(change.set).length > 0) {
        // Started now: the sweep counts its 30 days from here
        try {
          mkdirSync(root, { recursive: true })
          utimesSync(root, t / 1000, t / 1000)
        } catch (e) {
          a.log?.(`credentials: could not prepare ${root}: ${String(e)}`)
        }
      }
      return change
    },
    damaged: () => damaged
  }
}
