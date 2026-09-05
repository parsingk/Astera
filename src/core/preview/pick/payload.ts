// Makes the guest's answer safe. The picker runs inside the page, and a page can hand back anything —
// a payload-shaped object with a ten-megabyte outerHTML, a token in a data attribute, a URL that is
// not a page. Nothing from the guest reaches an annotation without passing through here.
// node: no imports — the renderer imports this file.
import { isSaneRect } from './rect'
import { PICK_BUDGET, STYLE_KEYS, type ComputedStyles, type PickPayload, type Rect } from './types'

const SECRET_NAME = /token|secret|passw|api[-_]?key|auth|cookie|session|csrf/i
/** 32+ characters of base64 or hex with nothing else — the shape of a key, not of a word. */
const SECRET_VALUE = /^(?:[A-Za-z0-9+/=_-]{32,}|[0-9a-fA-F]{32,})$/

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name)
}

/** http(s) only, with sensitive query parameters removed. Anything else becomes ''. */
export function sanitizeUrl(u: string): string {
  let parsed: URL
  try {
    parsed = new URL(u)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
  for (const key of [...parsed.searchParams.keys()]) if (isSecretName(key)) parsed.searchParams.delete(key)
  return parsed.href.slice(0, PICK_BUDGET.url)
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
const strOrNull = (v: unknown, max: number): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, max) : null)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const rect = (v: unknown): Rect | null => (isSaneRect(v) ? { x: v.x, y: v.y, width: v.width, height: v.height } : null)

function styles(v: unknown): ComputedStyles | null {
  if (v === null || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const out = {} as ComputedStyles
  for (const k of STYLE_KEYS) out[k] = str(o[k], 200)
  return out
}

function attributes(v: unknown): Record<string, string> {
  if (v === null || typeof v !== 'object') return {}
  const out: Record<string, string> = {}
  let n = 0
  for (const [name, value] of Object.entries(v as Record<string, unknown>)) {
    if (n >= PICK_BUDGET.attributes) break
    if (typeof value !== 'string') continue
    const key = name.slice(0, 100)
    out[key] = isSecretName(key) || SECRET_VALUE.test(value) ? '[redacted]' : value.slice(0, PICK_BUDGET.attributeValue)
    n += 1
  }
  return out
}

function nearbyText(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    .slice(0, PICK_BUDGET.nearbyTextEntries)
    .map((t) => t.slice(0, PICK_BUDGET.nearbyTextEntry))
}

/** The guest's raw pick, checked and clamped; null when it is not a pick at all. Required: the two
 *  rects, the styles object, the page object and a tag name. Everything else degrades to empty. */
export function clampPayload(raw: unknown): PickPayload | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const rectViewport = rect(o.rectViewport)
  const rectPage = rect(o.rectPage)
  const computedStyles = styles(o.computedStyles)
  const page = o.page
  if (!rectViewport || !rectPage || !computedStyles || page === null || typeof page !== 'object' || typeof o.tagName !== 'string') return null
  const p = page as Record<string, unknown>
  const a = o.accessibility !== null && typeof o.accessibility === 'object' ? (o.accessibility as Record<string, unknown>) : {}
  return {
    page: {
      url: sanitizeUrl(str(p.url, PICK_BUDGET.url)),
      title: str(p.title, PICK_BUDGET.title),
      viewportWidth: num(p.viewportWidth),
      viewportHeight: num(p.viewportHeight),
      devicePixelRatio: num(p.devicePixelRatio) || 1
    },
    tagName: o.tagName.toLowerCase().slice(0, 50),
    selector: str(o.selector, PICK_BUDGET.selector),
    elementPath: str(o.elementPath, PICK_BUDGET.elementPath),
    cssClasses: str(o.cssClasses, PICK_BUDGET.cssClasses),
    textSnippet: str(o.textSnippet, PICK_BUDGET.textSnippet),
    htmlSnippet: str(o.htmlSnippet, PICK_BUDGET.htmlSnippet),
    attributes: attributes(o.attributes),
    accessibility: { role: strOrNull(a.role, 50), accessibleName: strOrNull(a.accessibleName, PICK_BUDGET.accessibleName) },
    rectViewport,
    rectPage,
    isFixed: o.isFixed === true,
    computedStyles,
    nearbyText: nearbyText(o.nearbyText),
    reactComponents: strOrNull(o.reactComponents, PICK_BUDGET.reactComponents),
    sourceFile: strOrNull(o.sourceFile, PICK_BUDGET.sourceFile)
  }
}
