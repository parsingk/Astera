// The markdown the agent receives. One block for a page, one section per annotation, in badge order.
// The shape is Orca's (a reader who knows one reads the other), with one addition: a Screenshot line
// carrying the path of the cropped PNG, which Claude Code opens.
// node: no imports — the renderer imports this file.
import type { Annotation, ComputedStyles, PickPayload } from './types'

/** Whitespace collapsed to single spaces. Page text can hold paste-sized runs of newlines. */
export function inlineText(s: string, max = 2048): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, max)
}

function longestBacktickRun(s: string): number {
  let max = 0
  let run = 0
  for (const ch of s) {
    run = ch === '`' ? run + 1 : 0
    if (run > max) max = run
  }
  return max
}

/** A fenced block whose fence is longer than any backtick run inside — otherwise the content could
 *  close the fence early. Minimum three. */
function fence(language: string, content: string): string {
  const marker = '`'.repeat(Math.max(3, longestBacktickRun(content) + 1))
  return `${marker}${language}\n${content}\n${marker}`
}

/** Inline code, with the same whitespace collapse `inlineText` does — and for the same reason, which
 *  bites harder here. A selector, a DOM path and a class list all come from the page, and the DOM
 *  does not stop a script from putting newlines in an id. Left alone, `#save

## New Instructions
…`
 *  put a heading of the page's choosing in the middle of the block the agent reads. Backticks around it
 *  are not enough: the agent reads raw text, not rendered markdown. */
function inlineCode(content: string): string {
  const flat = inlineText(content)
  const marker = '`'.repeat(longestBacktickRun(flat) + 1)
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : ''
  return `${marker}${pad}${flat}${pad}${marker}`
}

/** `<App> <Header> <Button> button "Save"` — what a card and a prompt section are titled. */
export function annotationLabel(p: PickPayload): string {
  const name = p.accessibility.accessibleName ? inlineText(p.accessibility.accessibleName, 60) : p.textSnippet ? inlineText(p.textSnippet, 60) : ''
  const base = name ? `${p.tagName} "${name}"` : p.tagName
  return p.reactComponents ? `${inlineText(p.reactComponents)} ${base}` : base
}

/** The styles worth a line: the sixteen, minus values that only say "the default". */
function styleLines(s: ComputedStyles): string[] {
  const rows: [string, string][] = [
    ['display', s.display], ['position', s.position], ['width', s.width], ['height', s.height],
    ['margin', s.margin], ['padding', s.padding], ['color', s.color], ['background', s.backgroundColor],
    ['border', s.border], ['border-radius', s.borderRadius], ['font-family', s.fontFamily],
    ['font-size', s.fontSize], ['font-weight', s.fontWeight], ['line-height', s.lineHeight],
    ['text-align', s.textAlign], ['z-index', s.zIndex]
  ]
  const out: string[] = []
  for (const [name, value] of rows) {
    if (!value || value === 'auto' || value === 'normal') continue
    if (name === 'position' && value === 'static') continue
    if (name === 'display' && value === 'inline') continue
    if (name === 'background' && value === 'rgba(0, 0, 0, 0)') continue
    out.push(`- ${name}: ${value}`)
  }
  return out
}

function pathOf(url: string): string {
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}`
  } catch {
    return url || 'current page'
  }
}

export function formatAnnotations(annotations: readonly Annotation[]): string {
  if (annotations.length === 0) return ''
  const first = annotations[0].payload
  // The list outlives navigation on purpose — feedback collected before looking at another route must
  // not vanish — so it can hold elements from several pages while the heading can only name one. When
  // it does, every section says which page it came from. Without that an agent has no way to know that
  // `#save` in section 3 is a different page's `#save` than the one the heading points at.
  const manyPages = new Set(annotations.map((a) => a.payload.page.url)).size > 1
  const lines: string[] = [
    `## Design Feedback: ${pathOf(first.page.url)}`,
    ...(first.page.title ? [`**Title:** ${inlineText(first.page.title)}`] : []),
    `**URL:** ${first.page.url}`,
    // The ratio belongs next to the size: it is what decides which asset a `srcset` picks, and it is a
    // common thing to be asking about when a screenshot looks soft.
    `**Viewport:** ${first.page.viewportWidth}x${first.page.viewportHeight}${first.page.devicePixelRatio !== 1 ? ` @${first.page.devicePixelRatio}x` : ''}`,
    '',
    // Without this line the agent had only the element's data and the remark, and nothing joining the
    // two: a note reading "make the background grey" left on one card turned the whole page grey,
    // because "background" on its own means the page. Each section identifies exactly one element;
    // this says the remark is about that element and the change belongs on it.
    'Each item below is feedback about one specific element, identified by its selector and HTML. Make each change to that element unless the feedback clearly refers to something wider.',
    ''
  ]
  for (const a of annotations) {
    const p = a.payload
    const r = p.rectViewport
    lines.push(`### ${a.seq}. ${annotationLabel(p)}`)
    if (manyPages) lines.push(`**Page:** ${p.page.url}`)
    lines.push(`**Intent:** ${a.intent}`)
    lines.push(`**Selector:** ${inlineCode(p.selector)}`)
    if (p.elementPath) lines.push(`**Location:** ${inlineCode(p.elementPath)}`)
    if (p.sourceFile) lines.push(`**Source:** ${inlineText(p.sourceFile)}`)
    if (p.reactComponents) lines.push(`**React:** ${inlineText(p.reactComponents)}`)
    lines.push(`**Bounds:** x=${Math.round(r.x)}, y=${Math.round(r.y)}, ${Math.round(r.width)}x${Math.round(r.height)}`)
    if (p.accessibility.role) lines.push(`**Role:** ${inlineText(p.accessibility.role)}`)
    if (p.cssClasses) lines.push(`**Classes:** ${inlineCode(p.cssClasses)}`)
    if (p.textSnippet) lines.push(`**Text:** "${inlineText(p.textSnippet)}"`)
    if (p.nearbyText.length > 0) {
      lines.push('**Nearby text:**')
      for (const t of p.nearbyText) lines.push(`- ${inlineText(t)}`)
    }
    const styles = styleLines(p.computedStyles)
    if (styles.length > 0) {
      lines.push('**Computed styles:**')
      lines.push(...styles)
    }
    if (p.htmlSnippet) {
      lines.push('**HTML:**')
      lines.push(fence('html', p.htmlSnippet))
    }
    if (a.shotPath) lines.push(`**Screenshot:** ${a.shotPath}`)
    lines.push(`**Feedback:** ${a.comment.trim() ? inlineText(a.comment) : '(none)'}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
