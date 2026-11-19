import { LineCounter, isMap, isScalar, isSeq, parse, parseDocument } from 'yaml'
import type { Node, Pair, YAMLMap, YAMLSeq } from 'yaml'
import type { ManifestDoc } from './types'

// Runs in the renderer: only `yaml` and `./types` may be imported here, nothing from `node:*`.

interface Identity {
  kind: string
  name: string
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** Kind and `metadata.name` of one YAML document's text, or null when it names neither. */
export function docIdentity(text: string): Identity | null {
  try {
    const d = parse(text) as { kind?: unknown; metadata?: { name?: unknown } } | null
    const kind = str(d?.kind)
    const name = str(d?.metadata?.name)
    return kind && name ? { kind, name } : null
  } catch {
    return null
  }
}

/**
 * Whether a rendered resource is the one a patch is written for. Kustomize may add the overlay's `namePrefix` or
 * `nameSuffix` to the name, and this runs without the overlay's kustomization, so the rendered name only has to
 * contain the patch's name: a heuristic that can match a longer neighbour (`api` in `api-worker`), accepted here
 * because it only chooses a default resource and which lines to tint.
 */
export function sameResource(patch: Identity, rendered: Identity): boolean {
  return patch.kind === rendered.kind && rendered.name.includes(patch.name)
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const isNamed = (v: unknown): v is { name: string } => isRecord(v) && typeof v.name === 'string'

const hasDirective = (v: unknown): boolean =>
  Array.isArray(v)
    ? v.some(hasDirective)
    : isRecord(v)
      ? Object.entries(v).some(([k, x]) => k === '$patch' || hasDirective(x))
      : false

/**
 * 1-based lines of `renderedDoc` (one rendered resource's YAML) that a strategic-merge patch sets: its leaf values,
 * and a whole sub-tree when the patch gives an empty map or a list without names as a value. Lists of maps are
 * matched by `name`, the strategic-merge key of containers, volumes, ports and env. `[]` when the patch is for
 * another resource, is a JSON 6902 patch (a top-level list), uses `$patch`, or either text does not parse.
 */
export function patchLines(patchText: string, renderedDoc: string): number[] {
  try {
    const patch = parse(patchText) as unknown
    if (!isRecord(patch) || hasDirective(patch)) return []
    const lc = new LineCounter()
    const doc = parseDocument(renderedDoc, { lineCounter: lc })
    if (doc.errors.length > 0 || !isMap(doc.contents)) return []
    const patchId = docIdentity(patchText)
    const renderedId = docIdentity(renderedDoc)
    if (!patchId || !renderedId || !sameResource(patchId, renderedId)) return []

    const lines = new Set<number>()
    const lineOf = (offset: number): number => lc.linePos(offset).line
    const markSpan = (key: Node | null, node: Node | null): void => {
      const from = key?.range?.[0] ?? node?.range?.[0]
      if (from === undefined) return
      const end = node?.range ? Math.max(from, node.range[1] - 1) : from
      for (let l = lineOf(from); l <= lineOf(end); l++) lines.add(l)
    }

    const walkMap = (p: Record<string, unknown>, r: YAMLMap, top: boolean): void => {
      for (const [k, pv] of Object.entries(p)) {
        if (top && (k === 'apiVersion' || k === 'kind')) continue
        const pair = r.items.find((i) => isScalar(i.key) && String(i.key.value) === k) as Pair<Node, Node> | undefined
        if (!pair) continue
        if (top && k === 'metadata' && isRecord(pv) && isMap(pair.value)) {
          const { name: _name, ...rest } = pv
          walkMap(rest, pair.value, false)
        } else walkValue(pv, pair)
      }
    }

    const walkValue = (pv: unknown, pair: Pair<Node, Node>): void => {
      const rv = pair.value
      if (isMap(rv) && isRecord(pv) && Object.keys(pv).length > 0) walkMap(pv, rv, false)
      else if (isSeq(rv) && Array.isArray(pv) && pv.length > 0 && pv.every(isNamed)) walkSeq(pv, rv)
      else markSpan(pair.key, rv)
    }

    const walkSeq = (items: { name: string }[], r: YAMLSeq): void => {
      for (const item of items) {
        const match = r.items.find((n) => isMap(n) && String(n.get('name')) === item.name)
        if (isMap(match)) {
          const { name: _name, ...rest } = item // the key that matched is not a change
          walkMap(rest, match, false)
        }
      }
    }

    walkMap(patch, doc.contents, true)
    return [...lines].sort((a, b) => a - b)
  } catch {
    return []
  }
}
