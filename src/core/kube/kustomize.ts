/** Reads kustomization.yaml references and works out which kustomizations are overlays and which files they reach. */
import { parseAllDocuments } from 'yaml'
import { flavor, foldKeyPart } from './target'

export interface KustomizationRefs {
  resources: string[]
  patchFiles: string[]
  components: string[]
  namespace: string | null
  /** The text did not parse (or could not be read): what it lists is unknown, so nothing below it may be applied. */
  broken?: true
}

export interface KustomizeGraph {
  /** Kustomization folders no other kustomization references. */
  overlays(): string[]
  isBase(dir: string): boolean
  isOverlay(dir: string): boolean
  /** Overlays that reach `path`, a member file or a kustomization folder (directly or through bases). */
  overlaysReaching(path: string): string[]
  isMember(path: string): boolean
  namespaceOf(dir: string): string | null
  /** Whether `path` (a file or folder) lies in or below the folder of any kustomization. */
  inKustomization(path: string): boolean
  /** The folders of broken kustomizations (KustomizationRefs.broken) that `path` lies in or below, as given. */
  brokenOver(path: string): string[]
}

function isRemote(entry: string): boolean {
  return entry.includes('://') || entry.startsWith('github.com/') || entry.includes('?ref=')
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v !== '' && !isRemote(v))
}

function paths(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out = value.map((v) => (v && typeof v === 'object' ? (v as Record<string, unknown>).path : null))
  return strings(out)
}

/** Empty refs marked `broken` when the text does not parse. Remote entries are dropped; paths stay as written. */
export function parseKustomization(text: string): KustomizationRefs {
  // The first document that is a map wins; empty documents (`---` alone) and trailing documents are skipped.
  let obj: Record<string, unknown> = {}
  let broken = false
  try {
    // The BOM is built from its code point so no invisible character sits in the source.
    for (const d of parseAllDocuments(text.replace(new RegExp('^' + String.fromCharCode(0xfeff)), ''))) {
      if (d.errors.length > 0) {
        broken = true
        break
      }
      const v: unknown = d.toJS({ maxAliasCount: 100 })
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        obj = v as Record<string, unknown>
        break
      }
    }
  } catch {
    obj = {}
    broken = true
  }
  if (broken) return brokenKustomization()
  const ns = obj.namespace
  return {
    resources: [...strings(obj.resources), ...strings(obj.bases)],
    patchFiles: [
      ...paths(obj.patches),
      ...strings(obj.patchesStrategicMerge),
      ...paths(obj.patchesJson6902)
    ],
    components: strings(obj.components),
    namespace: typeof ns === 'string' && ns !== '' ? ns : null
  }
}

/** What a kustomization that cannot be parsed or read lists: nothing known. */
export function brokenKustomization(): KustomizationRefs {
  return { resources: [], patchFiles: [], components: [], namespace: null, broken: true }
}

/** The one spelling every key and lookup goes through: resolved (against `base` when given), and case-folded where
 *  the paths ignore case (Windows-style paths always, the rest as the host does), so a root spelled `d:/proj` finds
 *  what `D:/Proj` built. */
function norm(p: string, base?: string): string {
  const f = flavor(base ?? p)
  return foldKeyPart(base === undefined ? f.resolve(p) : f.resolve(base, p), f)
}

/** `roots` keys are absolute kustomization folders. Lookups match any spelling of a path; the paths returned are the
 *  keys as given. */
export function buildKustomizeGraph(roots: Record<string, KustomizationRefs>): KustomizeGraph {
  const original = new Map<string, string>() // normalized folder -> key as given
  for (const key of Object.keys(roots)) original.set(norm(key), key)

  const childDirs = new Map<string, string[]>()
  const ownFiles = new Map<string, string[]>()
  const referenced = new Set<string>()
  for (const [key, refs] of Object.entries(roots)) {
    const dir = norm(key)
    const dirs: string[] = []
    const files: string[] = []
    for (const entry of [...refs.resources, ...refs.components]) {
      const target = norm(entry, dir)
      if (original.has(target)) {
        if (target !== dir) {
          dirs.push(target)
          referenced.add(target)
        }
      } else if (refs.resources.includes(entry)) {
        files.push(target)
      }
    }
    for (const patch of refs.patchFiles) files.push(norm(patch, dir))
    childDirs.set(dir, dirs)
    ownFiles.set(dir, files)
  }

  // Everything one kustomization reaches, itself included; the visited set makes cycles terminate.
  const reach = (start: string): { dirs: Set<string>; files: Set<string> } => {
    const dirs = new Set<string>()
    const files = new Set<string>()
    const stack = [start]
    while (stack.length > 0) {
      const dir = stack.pop() as string
      if (dirs.has(dir)) continue
      dirs.add(dir)
      for (const f of ownFiles.get(dir) ?? []) files.add(f)
      stack.push(...(childDirs.get(dir) ?? []))
    }
    return { dirs, files }
  }

  const overlayDirs = [...original.keys()].filter((dir) => !referenced.has(dir))
  const reaches = new Map(overlayDirs.map((dir) => [dir, reach(dir)]))
  const members = new Set<string>()
  for (const dir of original.keys()) for (const f of reach(dir).files) members.add(f)

  return {
    overlays: () => overlayDirs.map((dir) => original.get(dir) as string),
    isBase: (dir) => referenced.has(norm(dir)),
    isOverlay: (dir) => overlayDirs.includes(norm(dir)),
    overlaysReaching: (path) => {
      const target = norm(path)
      return overlayDirs
        .filter((dir) => {
          const r = reaches.get(dir) as { dirs: Set<string>; files: Set<string> }
          return r.dirs.has(target) || r.files.has(target)
        })
        .map((dir) => original.get(dir) as string)
    },
    isMember: (path) => members.has(norm(path)),
    namespaceOf: (dir) => roots[original.get(norm(dir)) ?? '']?.namespace ?? null,
    inKustomization: (path) => {
      const target = norm(path)
      return [...original.keys()].some((dir) => within(dir, target))
    },
    brokenOver: (path) => {
      const target = norm(path)
      return [...original.entries()]
        .filter(([dir, key]) => roots[key].broken === true && within(dir, target))
        .map(([, key]) => key)
        .sort()
    }
  }
}

/** Whether normalized `target` is normalized `dir` or lies below it. */
function within(dir: string, target: string): boolean {
  const sep = flavor(dir).sep
  return target === dir || target.startsWith(dir.endsWith(sep) ? dir : dir + sep)
}
