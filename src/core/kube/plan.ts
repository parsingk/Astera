/** Turns a selection of files and folders into the kubectl commands that apply it (spec §4.4). */
import type { KustomizeGraph } from './kustomize'
import type { KubeFileKind, LeftOut, OperationPlan, PlanCommand } from './types'

export interface FolderIndex {
  kindOf(path: string): KubeFileKind
  isDir(path: string): boolean
  /** Every file below `dir`, recursively. */
  filesUnder(dir: string): string[]
  graph: KustomizeGraph
}

type Refusal = 'broken-kustomization' | 'base-folder' | 'many-overlays'

function dirOf(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf(String.fromCharCode(92))))
}

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export function planOperation(selection: string[], index: FolderIndex): OperationPlan {
  const { graph } = index
  const files = new Set<string>()
  const overlays = new Set<string>()
  const leftOut = new Map<string, LeftOut>()
  const refusals: { reason: Refusal; path: string }[] = []

  const skip = (path: string, reason: LeftOut['reason']): void => {
    leftOut.set(reason + '\0' + path, { path, reason })
  }

  /** Fails closed: anything in or below a kustomization that does not parse is refused, since what it lists (and so
   *  which files are patches rather than resources) is unknown. True when `path` is refused so. */
  const brokenRefusal = (path: string): boolean => {
    const broken = graph.brokenOver(path)
    for (const dir of broken) refusals.push({ reason: 'broken-kustomization', path: dir })
    return broken.length > 0
  }

  /** A manifest no kustomization lists goes into -f, unless it sits in or below a kustomization's folder: that one
   *  does not list it, so it may be a patch or a transformer config kubectl must not apply as a resource. */
  const takeLoose = (path: string): void => {
    if (graph.inKustomization(path)) skip(path, 'unlisted')
    else files.add(path)
  }

  // A kustomization folder named directly: an overlay is applied with -k, a base is refused.
  const takeFolder = (dir: string): void => {
    if (brokenRefusal(dir)) return
    if (graph.isOverlay(dir)) overlays.add(dir)
    else if (graph.isBase(dir)) refusals.push({ reason: 'base-folder', path: dir })
  }

  const takeFile = (path: string): void => {
    if (brokenRefusal(path)) return
    const kind = index.kindOf(path)
    if (kind === 'kustomization') return takeFolder(dirOf(path))
    if (kind === 'helm-template') return skip(path, 'helm')
    if (kind === 'plain') return skip(path, 'plain-yaml')
    if (!graph.isMember(path)) return takeLoose(path)
    const reaching = graph.overlaysReaching(path)
    if (reaching.length === 1) overlays.add(reaching[0])
    else if (reaching.length > 1) refusals.push({ reason: 'many-overlays', path })
    else skip(path, 'base-member')
  }

  const walk = (dir: string): void => {
    if (brokenRefusal(dir)) return
    const found = index.filesUnder(dir)
    const foundOverlays = new Set<string>()
    for (const f of found) {
      if (index.kindOf(f) !== 'kustomization') continue
      const d = dirOf(f)
      // Every file below a broken kustomization is below its kustomization file, which the walk finds too.
      if (brokenRefusal(d)) continue
      if (graph.isOverlay(d)) foundOverlays.add(d)
      else if (graph.isBase(d)) skip(d, 'base')
    }
    for (const o of foundOverlays) overlays.add(o)
    for (const f of found) {
      const kind = index.kindOf(f)
      if (kind === 'kustomization') continue
      if (kind === 'helm-template') skip(f, 'helm')
      else if (kind === 'plain') skip(f, 'plain-yaml')
      else if (!graph.isMember(f)) takeLoose(f)
      // Members of an overlay found here are covered by its -k; any other member belongs to a base.
      else if (!graph.overlaysReaching(f).some((o) => foundOverlays.has(o))) skip(f, 'base-member')
    }
  }

  for (const item of selection) {
    if (!index.isDir(item)) takeFile(item)
    else if (graph.isOverlay(item) || graph.isBase(item)) takeFolder(item)
    else walk(item)
  }

  if (refusals.length > 0) {
    // Fixed precedence so the answer never depends on selection order; a broken kustomization is fixed first.
    const order: Refusal[] = ['broken-kustomization', 'base-folder', 'many-overlays']
    const reason = order.find((x) => refusals.some((r) => r.reason === x)) as Refusal
    const paths = [...new Set(refusals.filter((r) => r.reason === reason).map((r) => r.path))].sort(byPath)
    return { ok: false, reason, paths }
  }

  const commands: PlanCommand[] = []
  if (files.size > 0) commands.push({ kind: 'files', files: [...files].sort(byPath) })
  for (const dir of [...overlays].sort(byPath)) commands.push({ kind: 'overlay', dir })
  if (commands.length === 0) return { ok: false, reason: 'nothing', paths: [...selection], leftOut: [...leftOut.values()] }
  return { ok: true, commands, leftOut: [...leftOut.values()] }
}
