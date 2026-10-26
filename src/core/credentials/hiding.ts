// Keeping the Credentials list's keys and logins out of agent sessions (credentials design §5). The session managers ask
// `HidingSource.get(cwd)` while they build a session's environment, before Astera adds its own variables, so nothing an
// entry names can take away the session's identity, its Gateway token or a value a shared server is given.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { isPathWithin } from '../files/tree'
import { extensionPaths, profilePaths } from '../profile/paths'
import type { ExtensionRegistry } from '../extensions/types'
import { mcpSecretEntries } from './mcpEntries'
import { PRESETS } from './presets'
import { isProtectedName, parseCredentials } from './store'
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
    if (!isProtectedName(n) && !remove.includes(n)) remove.push(n)
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
        if (isProtectedName(name)) continue
        set[name] = kind === 'empty-dir' ? path.join(a.emptyDir, p.id) : path.join(a.emptyDir, p.id, name)
      }
    }
  }
  return { remove, set }
}

/** Takes the change into `env`: names removed case-insensitively on win32 (Windows variables are), exactly elsewhere; each
 *  redirect's empty folder or file made when it is not there yet. */
export function applyHiding(env: Record<string, string | undefined>, h: HidingChange, platform: NodeJS.Platform): void {
  const sameName = (a: string, b: string): boolean => (platform === 'win32' ? a.toUpperCase() === b.toUpperCase() : a === b)
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

/** A worker's folder is a worktree outside its project: the worktree registry says which project it belongs to. */
export function projectOfWorktrees(list: () => readonly { path: string; repoPath: string }[]): (cwd: string) => string {
  return (cwd) => list().find((w) => isPathWithin(w.path, cwd))?.repoPath ?? cwd
}

export interface HidingSource {
  get(cwd: string): HidingChange
  /** The list file is damaged: nothing is hidden until it is repaired (Settings and `doctor` say so). */
  damaged(): boolean
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Reads the list and the shared MCP servers at every call, so a change counts for the next session whichever process
 *  starts it. Both are small files read once per spawn. Never throws: a damaged list hides nothing. */
export function createHidingSource(a: { profileDir: string; projectOf: (cwd: string) => string }): HidingSource {
  let damaged = false
  const readList = (): CredentialsFile | null => {
    let text: string
    try {
      text = readFileSync(profilePaths(a.profileDir).credentials, 'utf8')
    } catch {
      return { version: 1, entries: [], mcpHide: {} }
    }
    return parseCredentials(text)
  }
  const readRegistry = (): ExtensionRegistry => {
    try {
      const v: unknown = JSON.parse(readFileSync(extensionPaths(a.profileDir).registry, 'utf8'))
      return isRecord(v) && v.version === 1 && Array.isArray(v.entries) ? (v as unknown as ExtensionRegistry) : { version: 1, entries: [] }
    } catch {
      return { version: 1, entries: [] }
    }
  }
  return {
    get(cwd) {
      const list = readList()
      damaged = list === null
      if (list === null) return { remove: [], set: {} }
      let shared: CredentialEntry[] = []
      try {
        shared = mcpSecretEntries(readRegistry(), list.mcpHide)
      } catch {
        // A registry Astera did not write in this shape: its servers' variables are not hidden, the spawn goes on
      }
      const entries: CredentialEntry[] = [...list.entries, ...shared]
      return hidingFor({ entries, cwd, projectOf: a.projectOf, emptyDir: profilePaths(a.profileDir).credentialEmpty })
    },
    damaged: () => damaged
  }
}
