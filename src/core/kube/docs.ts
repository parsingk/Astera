/** Reads the Kubernetes objects out of a (possibly multi-document) YAML text. */
import { parseAllDocuments } from 'yaml'
import type { ManifestDoc } from './types'

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** One entry per document that has `apiVersion` and `kind`. Documents that do not, or do not parse, are skipped;
 *  `index` still counts them. A `kind: List` stays one entry (lists are expanded only for cluster output). */
export function parseManifestDocs(text: string): ManifestDoc[] {
  const out: ManifestDoc[] = []
  try {
    parseAllDocuments(text.replace(new RegExp('^' + String.fromCharCode(0xfeff)), '')).forEach((doc, index) => {
      if (doc.errors.length > 0) return
      let value: unknown
      try {
        value = doc.toJS({ maxAliasCount: 100 })
      } catch {
        return // e.g. an alias bomb: skip this document, keep the later ones
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return
      const obj = value as Record<string, unknown>
      const apiVersion = str(obj.apiVersion)
      const kind = str(obj.kind)
      if (!apiVersion || !kind) return
      const meta = obj.metadata && typeof obj.metadata === 'object' ? (obj.metadata as Record<string, unknown>) : {}
      out.push({ index, apiVersion, kind, name: str(meta.name), namespace: str(meta.namespace) })
    })
  } catch {
    // parseAllDocuments itself threw: keep what was collected before it.
  }
  return out
}
