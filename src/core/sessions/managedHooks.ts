// Whether an organization's Claude Code policy turns hooks off on this machine (final review C2). Managed settings sit
// above everything a session passes, `--settings` included, so `"disableAllHooks": true` or `"allowManagedHooksOnly":
// true` there skips Astera's blocking hook, and a session started in Enforce would run unprotected: it does not start.
// The sources and places are Claude Code's managed settings reference (code.claude.com/docs/en/managed-settings): the
// file and its drop-ins in the system directory, the HKLM and HKCU registry policy on Windows, the managed preferences
// on macOS. Settings an organization serves from the claude.ai console are fetched by Claude Code itself and cannot be
// read here.
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Where each OS keeps `managed-settings.json` and `managed-settings.d/`. */
export function managedSettingsDir(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode'
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode'
  return '/etc/claude-code'
}

const REGISTRY_KEYS = ['HKLM\\SOFTWARE\\Policies\\ClaudeCode', 'HKCU\\SOFTWARE\\Policies\\ClaudeCode']

export interface ManagedReaders {
  platform: NodeJS.Platform
  /** A file's text, or null when it is not there or cannot be read. */
  readText(file: string): Promise<string | null>
  listDir(dir: string): Promise<string[]>
  /** Windows: the `Settings` value under a policy key, or null. */
  registry?(key: string): Promise<string | null>
  /** macOS: the managed preferences of `com.anthropic.claudecode` as JSON, or null. */
  plist?(): Promise<string | null>
}

const turnsHooksOff = (text: string | null): boolean => {
  if (text === null) return false
  try {
    const v: unknown = JSON.parse(text)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
    const s = v as Record<string, unknown>
    return s.disableAllHooks === true || s.allowManagedHooksOnly === true
  } catch {
    // A document Claude Code cannot parse keeps it from starting at all: nothing here to refuse
    return false
  }
}

/** Whether any managed source this machine holds turns Claude Code's hooks off. Never rejects. */
export async function claudeManagedHooksOff(r: ManagedReaders): Promise<boolean> {
  const p = r.platform === 'win32' ? path.win32 : path.posix
  const dir = managedSettingsDir(r.platform)
  const texts: Array<Promise<string | null>> = [r.readText(p.join(dir, 'managed-settings.json'))]
  const dropIns = p.join(dir, 'managed-settings.d')
  for (const name of (await r.listDir(dropIns).catch(() => [])).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort())
    texts.push(r.readText(p.join(dropIns, name)))
  if (r.platform === 'win32' && r.registry) for (const key of REGISTRY_KEYS) texts.push(r.registry(key))
  if (r.platform === 'darwin' && r.plist) texts.push(r.plist())
  const read = await Promise.all(texts.map((t) => t.catch(() => null)))
  return read.some(turnsHooksOff)
}

const run = (file: string, args: string[]): Promise<string | null> =>
  new Promise((resolve) => execFile(file, args, { windowsHide: true, encoding: 'utf8', timeout: 5_000 }, (err, stdout) => resolve(err ? null : stdout)))

/** The readers of this machine. */
export function machineManagedReaders(platform: NodeJS.Platform): ManagedReaders {
  return {
    platform,
    readText: (file) => fs.readFile(file, 'utf8').catch(() => null),
    listDir: (dir) => fs.readdir(dir).catch(() => []),
    registry: async (key) => {
      const out = await run('reg', ['query', key, '/v', 'Settings'])
      const m = out === null ? null : /^\s*Settings\s+REG_(?:EXPAND_)?SZ\s+(.*)$/m.exec(out)
      return m ? m[1].trim() : null
    },
    plist: async () => {
      const base = '/Library/Managed Preferences'
      for (const file of [path.posix.join(base, os.userInfo().username, 'com.anthropic.claudecode.plist'), path.posix.join(base, 'com.anthropic.claudecode.plist')]) {
        const json = await run('plutil', ['-convert', 'json', '-o', '-', file])
        if (json !== null) return json
      }
      return null
    }
  }
}

/** The answer read off the thread before a spawn (`warm`) and read synchronously at it (`off`). */
export function createManagedHooksCheck(platform: NodeJS.Platform, readers: ManagedReaders = machineManagedReaders(platform)): { warm(): Promise<void>; off(): boolean } {
  let off = false
  return {
    warm: async () => {
      off = await claudeManagedHooksOff(readers)
    },
    off: () => off
  }
}
