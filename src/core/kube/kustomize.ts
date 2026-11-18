/** Reads kustomization.yaml references and works out which kustomizations are overlays and which files they reach. */
import { resolve } from 'node:path'
import { parseAllDocuments } from 'yaml'

export interface KustomizationRefs {
  resources: string[]
  patchFiles: string[]
  components: string[]
  namespace: string | null
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

/** Empty refs when the text does not parse. Remote entries are dropped; paths stay as written. */
export function parseKustomization(text: string): KustomizationRefs {
  // The first document that is a map wins; empty documents (`---` alone) and trailing documents are skipped.
  let obj: Record<string, unknown> = {}
  try {
    // The BOM is built from its code point so no invisible character sits in the source.
    for (const d of parseAllDocuments(text.replace(new RegExp('^' + String.fromCharCode(0xfeff)), ''))) {
      if (d.errors.length > 0) break
      const v: unknown = d.toJS({ maxAliasCount: 100 })
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        obj = v as Record<string, unknown>
        break
      }
    }
  } catch {
    obj = {}
  }
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

/** `roots` keys are absolute kustomization folders. */
export function buildKustomizeGraph(roots: Record<string, KustomizationRefs>): KustomizeGraph {
  const original = new Map<string, string>() // normalized folder -> key as given
  for (const key of Object.keys(roots)) original.set(resolve(key), key)

  const childDirs = new Map<string, string[]>()
  const ownFiles = new Map<string, string[]>()
  const referenced = new Set<string>()
  for (const [key, refs] of Object.entries(roots)) {
    const dir = resolve(key)
    const dirs: string[] = []
    const files: string[] = []
    for (const entry of [...refs.resources, ...refs.components]) {
      const target = resolve(dir, entry)
      if (original.has(target)) {
        if (target !== dir) {
          dirs.push(target)
          referenced.add(target)
        }
      } else if (refs.resources.includes(entry)) {
        files.push(target)
      }
    }
    for (const patch of refs.patchFiles) files.push(resolve(dir, patch))
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
    isBase: (dir) => referenced.has(resolve(dir)),
    isOverlay: (dir) => overlayDirs.includes(resolve(dir)),
    overlaysReaching: (path) => {
      const target = resolve(path)
      return overlayDirs
        .filter((dir) => {
          const r = reaches.get(dir) as { dirs: Set<string>; files: Set<string> }
          return r.dirs.has(target) || r.files.has(target)
        })
        .map((dir) => original.get(dir) as string)
    },
    isMember: (path) => members.has(resolve(path)),
    namespaceOf: (dir) => roots[original.get(resolve(dir)) ?? '']?.namespace ?? null
  }
}
