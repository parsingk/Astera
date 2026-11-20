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

export function toWatchEvent(v: unknown): WatchEvent | null {
  if (typeof v !== 'object' || v === null) return null
  const { type, object } = v as { type?: unknown; object?: unknown }
  if (typeof type !== 'string' || !EVENT_TYPES.has(type)) return null
  if (typeof object !== 'object' || object === null) return null
  return { type: type as WatchEvent['type'], object: object as K8sObject }
}

export const keyOf = (o: K8sObject): string => (typeof o.metadata.uid === 'string' ? o.metadata.uid : `${o.metadata.namespace ?? ''}/${o.metadata.name}`)
