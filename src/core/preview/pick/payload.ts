// Makes the guest's answer safe. The picker runs inside the page, and a page can hand back anything —
// a payload-shaped object with a ten-megabyte outerHTML, a token in a data attribute, a URL that is
// not a page. Nothing from the guest reaches an annotation without passing through here.
// node: no imports — the renderer imports this file.
import { isSaneRect } from './rect'
import { PICK_BUDGET, STYLE_KEYS, type ComputedStyles, type PickPayload, type Rect } from './types'

const SECRET_NAME = /token|secret|passw|api[-_]?key|auth|cookie|session|csrf|jwt|bearer|credential|private[-_]?key/i
/** One long unbroken run of base64 or hex — the shape of a key, not of a word. */
const SECRET_RUN = /^(?:[A-Za-z0-9+/=_-]{32,}|[0-9a-fA-F]{32,})$/
/** Three base64url segments joined by dots: a JWT, and anything else built the same way. The dots are
 *  why SECRET_RUN misses these — it wants one unbroken run — and a name like `data-jwt` on its own
 *  told us nothing before `jwt` joined SECRET_NAME. Ten characters a segment keeps version strings
 *  and dotted host names out of it. */
const SECRET_SEGMENTS = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name)
}

/** Does this value look like a secret whatever it is called? Deliberately biased towards redacting:
 *  a content hash or a dash-free UUID is caught too, and losing one of those from a prompt costs
 *  nothing next to leaking a key. */
export function isSecretValue(value: string): boolean {
  return SECRET_RUN.test(value) || SECRET_SEGMENTS.test(value)
}

/** http(s) only, with credentials and sensitive query parameters removed. Anything else becomes ''.
 *
 *  Credentials go unconditionally. `new URL().href` keeps `user:pass@host` verbatim, and this URL is a
 *  required field that reaches the prompt on every single pick — so a staging address written the
 *  Basic-auth way would leak without the page doing anything at all.
 *
 *  A parameter goes when its **name** looks secret or its **value** does. Checking only the name left
 *  the same string redacted as an attribute and untouched as `?ref=<40 hex chars>`, which is the same
 *  boundary treating the same secret two ways. */
export function sanitizeUrl(u: string): string {
  let parsed: URL
  try {
    parsed = new URL(u)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
  parsed.username = ''
  parsed.password = ''
  for (const [key, value] of [...parsed.searchParams.entries()])
    if (isSecretName(key) || isSecretValue(value)) parsed.searchParams.delete(key)
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
  for (const k of STYLE_KEYS) out[k] = str(o[k], PICK_BUDGET.styleValue)
  return out
}

function attributes(v: unknown): Record<string, string> {
  if (v === null || typeof v !== 'object') return {}
  const out: Record<string, string> = {}
  let n = 0
  for (const [name, value] of Object.entries(v as Record<string, unknown>)) {
    if (n >= PICK_BUDGET.attributes) break
    if (typeof value !== 'string') continue
    const key = name.slice(0, PICK_BUDGET.attributeName)
    out[key] = isSecretName(key) || isSecretValue(value) ? '[redacted]' : value.slice(0, PICK_BUDGET.attributeValue)
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
    tagName: o.tagName.toLowerCase().slice(0, PICK_BUDGET.tagName),
    selector: str(o.selector, PICK_BUDGET.selector),
    elementPath: str(o.elementPath, PICK_BUDGET.elementPath),
    cssClasses: str(o.cssClasses, PICK_BUDGET.cssClasses),
    textSnippet: str(o.textSnippet, PICK_BUDGET.textSnippet),
    htmlSnippet: str(o.htmlSnippet, PICK_BUDGET.htmlSnippet),
    attributes: attributes(o.attributes),
    accessibility: { role: strOrNull(a.role, PICK_BUDGET.role), accessibleName: strOrNull(a.accessibleName, PICK_BUDGET.accessibleName) },
    rectViewport,
    rectPage,
    isFixed: o.isFixed === true,
    computedStyles,
    nearbyText: nearbyText(o.nearbyText),
    reactComponents: strOrNull(o.reactComponents, PICK_BUDGET.reactComponents),
    sourceFile: strOrNull(o.sourceFile, PICK_BUDGET.sourceFile)
  }
}
