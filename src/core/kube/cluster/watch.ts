/** Parsing of `kubectl get --watch -o json --output-watch-events`, which prints pretty-printed objects back to back. */
import type { K8sObject } from '../objects'
import type { WatchEvent } from './types'

type Parsed = { ok: true; value: unknown } | { ok: false }

/** Scans for balanced top-level objects, aware of strings and escapes, so chunk edges and braces inside values are safe. */
export function createJsonSplitter(): { push(chunk: string): Parsed[] } {
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
 *  (`ConfigMapList`, `List`, or no kind), its items carrying their own kind; small lists come an object per event. */
export function toWatchEvents(v: unknown): WatchEvent[] {
  if (!isObject(v)) return []
  const { type, object } = v as { type?: unknown; object?: unknown }
  if (typeof type !== 'string' || !EVENT_TYPES.has(type)) return []
  if (!isObject(object)) return []
  const items = (object as { items?: unknown }).items
  const objects = Array.isArray(items) ? items.filter(isObject) : [object]
  return objects.map((o) => ({ type: type as WatchEvent['type'], object: o as K8sObject }))
}

export const keyOf = (o: K8sObject): string => (typeof o.metadata.uid === 'string' ? o.metadata.uid : `${o.metadata.namespace ?? ''}/${o.metadata.name}`)
