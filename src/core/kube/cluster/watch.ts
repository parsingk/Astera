/** Parsing of `kubectl get --watch -o json --output-watch-events`, which prints pretty-printed objects back to back. */
import type { K8sObject } from '../objects'
import type { WatchEvent } from './types'

/** `tooLarge`: the value passed the cap and was given up, as against output that is merely not JSON. */
type Parsed = { ok: true; value: unknown } | { ok: false; tooLarge?: true }

/** The longest value the splitter holds. kubectl's values are a watch event or a page of 500 objects, which a namespace
 *  of Helm release Secrets can take past 16 MB; past this, the value is taken for broken output and given up. */
const MAX_VALUE_CHARS = 64 * 1024 * 1024

/** Scans for balanced top-level objects, aware of strings and escapes, so chunk edges and braces inside values are safe.
 *  A value that grows past `maxChars` (one that never closes) is reported too large and the scan starts afresh, so it
 *  neither holds memory without bound nor swallows the values after it. */
export function createJsonSplitter(maxChars = MAX_VALUE_CHARS): { push(chunk: string): Parsed[] } {
  let buf = ''
  let depth = 0
  let inString = false
  let escaped = false
  return {
    push(chunk: string): Parsed[] {
      const out: Parsed[] = []
      for (const ch of chunk) {
        if (depth === 0 && ch !== '{') continue // whitespace between objects
        buf += ch
        if (buf.length > maxChars) {
          out.push({ ok: false, tooLarge: true })
          buf = ''
          depth = 0
          inString = false
          escaped = false
          continue
        }
        if (inString) {
          if (escaped) escaped = false
          else if (ch === '\\') escaped = true
          else if (ch === '"') inString = false
          continue
        }
        if (ch === '"') inString = true
        else if (ch === '{') depth++
        else if (ch === '}' && --depth === 0) {
          try {
            out.push({ ok: true, value: JSON.parse(buf) })
          } catch {
            out.push({ ok: false })
          }
          buf = ''
        }
      }
      return out
    }
  }
}

const EVENT_TYPES = new Set(['ADDED', 'MODIFIED', 'DELETED'])

const isObject = (v: unknown): v is object => typeof v === 'object' && v !== null

/** The events of one watch value: none for a value that is not an event, else one, or one per item when its object is
 *  a list. kubectl prints each page of a big initial list (500 objects) as one event whose object is the page's list
 *  (`ConfigMapList`, `List`, or no kind), its items carrying their own kind; small lists come an object per event. Only
 *  such a list is split: a custom resource may have a top-level `items` field of its own. */
export function toWatchEvents(v: unknown): WatchEvent[] {
  if (!isObject(v)) return []
  const { type, object } = v as { type?: unknown; object?: unknown }
  if (typeof type !== 'string' || !EVENT_TYPES.has(type)) return []
  if (!isObject(object)) return []
  const { items, kind } = object as { items?: unknown; kind?: unknown }
  const isList = Array.isArray(items) && (kind === undefined || (typeof kind === 'string' && kind.endsWith('List')))
  const objects = isList ? (items as unknown[]).filter(isObject) : [object]
  return objects.map((o) => ({ type: type as WatchEvent['type'], object: o as K8sObject }))
}

export const keyOf = (o: K8sObject): string => (typeof o.metadata.uid === 'string' ? o.metadata.uid : `${o.metadata.namespace ?? ''}/${o.metadata.name}`)
