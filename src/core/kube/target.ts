/** Which kubeconfig context a file targets, and the names to show for it (spec D5, D7, C11, C21). */
import path from 'node:path'
import { foldPathCase } from '../files/paths'
import type { KubeContext, KubeContexts, KubeProvider, Remembered, TargetState } from './types'

/** Windows paths (drive letter or backslash) use win32 rules whatever the host is; the rest use POSIX. */
function flavor(p: string): typeof path.posix {
  return /^[A-Za-z]:|\\/.test(p) ? path.win32 : path.posix
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

function providerOf(name: string, server: string | null): KubeProvider | null {
  if (name.startsWith('arn:aws:eks:')) return 'eks'
  if (name.startsWith('gke_')) return 'gke'
  if (server) {
    try {
      if (new URL(server).hostname.toLowerCase().endsWith('.eks.amazonaws.com')) return 'eks'
    } catch {
      // not a URL: no provider from the server
    }
  }
  return null
}

/** Reads `kubectl config view -o json` (redacted output); never throws. */
export function parseConfigView(json: string): KubeContexts {
  let root: unknown
  try {
    root = JSON.parse(json)
  } catch {
    return { contexts: [], current: null }
  }
  if (!isRecord(root)) return { contexts: [], current: null }

  const servers = new Map<string, string>()
  if (Array.isArray(root.clusters)) {
    for (const c of root.clusters) {
      if (!isRecord(c)) continue
      const name = str(c.name)
      const server = isRecord(c.cluster) ? str(c.cluster.server) : null
      if (name && server) servers.set(name, server)
    }
  }

  const contexts: KubeContext[] = []
  if (Array.isArray(root.contexts)) {
    for (const c of root.contexts) {
      if (!isRecord(c)) continue
      const name = str(c.name)
      if (!name) continue
      const inner = isRecord(c.context) ? c.context : {}
      const cluster = str(inner.cluster) ?? ''
      contexts.push({
        name,
        namespace: str(inner.namespace),
        cluster,
        provider: providerOf(name, servers.get(cluster) ?? null)
      })
    }
  }
  return { contexts, current: str(root['current-context']) }
}

/** The folder the choice is remembered for by default: the overlay folder, else the first folder
 *  under the project root on the file's path (the root itself for a file directly in it). */
export function defaultRememberFolder(filePath: string, projectRoot: string, overlayDir: string | null): string {
  if (overlayDir) return overlayDir
  const p = flavor(projectRoot)
  const segments = p.relative(projectRoot, filePath).split(p.sep)
  if (segments.length <= 1 || segments[0] === '..') return projectRoot
  return p.join(projectRoot, segments[0])
}

/** Folders from the file's own folder up to the project root, nearest first. */
export function foldersUpTo(filePath: string, projectRoot: string): string[] {
  const p = flavor(projectRoot)
  const folders: string[] = []
  let dir = p.dirname(filePath)
  for (;;) {
    const rel = p.relative(projectRoot, dir)
    if (rel === '' || rel.startsWith('..') || p.isAbsolute(rel)) break
    folders.push(dir)
    const parent = p.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  folders.push(projectRoot)
  return folders
}

/** The nearest remembered folder wins. A remembered context kubeconfig no longer lists is `missing`
 *  and never falls back to the current context (C11). */
export function resolveTarget(
  folders: string[],
  remembered: (folder: string) => Remembered | undefined,
  contexts: KubeContexts
): TargetState {
  for (const folder of folders) {
    const r = remembered(folder)
    if (!r) continue
    if (!contexts.contexts.some((c) => c.name === r.context)) return { state: 'missing', context: r.context, folder }
    return { state: 'remembered', context: r.context, namespace: r.namespace, folder }
  }
  const current = contexts.contexts.find((c) => c.name === contexts.current)
  if (current) return { state: 'current', context: current.name, namespace: current.namespace }
  return { state: 'none' }
}

/** Case rule for a key part: Windows-style paths are always case-insensitive, the rest follow the host (foldPathCase). */
function foldKeyPart(p: string, flavored: typeof path.posix): string {
  return flavored === path.win32 ? p.toLowerCase() : foldPathCase(p)
}

function slashes(p: string): string {
  return p.split(String.fromCharCode(92)).join('/')
}

/** Store key for a folder: shared by every worktree of a repository, or the folded absolute path outside git
 *  (also for a folder that is not under the repository top). Stable however the caller spells the paths. */
export function targetKey(folder: string, repo: { top: string; commonDir: string } | null): string {
  const outside = foldKeyPart(flavor(folder).resolve(folder), flavor(folder))
  if (!repo) return outside
  const p = flavor(repo.top)
  const rel = p.relative(repo.top, folder)
  if (rel === '..' || rel.startsWith('..' + p.sep) || p.isAbsolute(rel)) return outside
  const common = foldKeyPart(slashes(flavor(repo.commonDir).resolve(repo.commonDir)), flavor(repo.commonDir))
  return `${common}|${foldKeyPart(slashes(rel), p)}`
}

/** Short and detail text for a context name: EKS ARN -> cluster + region, GKE -> cluster + zone. */
export function displayContextName(name: string): { short: string; detail: string | null } {
  const eks = /^arn:aws:eks:([^:]+):[^:]*:cluster\/(.+)$/.exec(name)
  if (eks) return { short: eks[2], detail: eks[1] }
  const gke = /^gke_[^_]+_([^_]+)_(.+)$/.exec(name)
  if (gke) return { short: gke[2], detail: gke[1] }
  return { short: name, detail: null }
}
