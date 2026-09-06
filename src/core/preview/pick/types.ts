// The shapes Design Mode passes around. Pure — the renderer, main and the tests all import this.
// node: no imports — the renderer imports this file.

export type Rect = { x: number; y: number; width: number; height: number }

/** The sixteen computed styles Orca reads, and the ones a designer's remark is usually about. */
export interface ComputedStyles {
  display: string
  position: string
  width: string
  height: string
  margin: string
  padding: string
  color: string
  backgroundColor: string
  border: string
  borderRadius: string
  fontFamily: string
  fontSize: string
  fontWeight: string
  lineHeight: string
  textAlign: string
  zIndex: string
}

export const STYLE_KEYS: readonly (keyof ComputedStyles)[] = [
  'display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'backgroundColor', 'border',
  'borderRadius', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'textAlign', 'zIndex'
]

/** What one click captures, after clampPayload has made it safe. */
export interface PickPayload {
  page: {
    url: string
    title: string
    viewportWidth: number
    viewportHeight: number
    devicePixelRatio: number
  }
  tagName: string
  /** `#id` when the id is unique in the document, else a `tag:nth-of-type()` chain up to five levels. */
  selector: string
  /** `main > section.hero > button.cta` — outermost first, up to ten levels, the element last. */
  elementPath: string
  cssClasses: string
  textSnippet: string
  htmlSnippet: string
  accessibility: { role: string | null; accessibleName: string | null }
  /** Where the pointer was when the element was picked, in the page's own pixels. The comment box
   *  opens beside it. Not part of the prompt — a click position says nothing to an agent. */
  clickViewport: { x: number; y: number }
  rectViewport: Rect
  rectPage: Rect
  isFixed: boolean
  computedStyles: ComputedStyles
  nearbyText: string[]
  /** `<App> <Header> <Button>` from the React fiber chain; null when the page is not React. */
  reactComponents: string | null
  /** A file path plus line and column (e.g. a component's source location), read from
   *  `fiber._debugSource`. React 18 dev builds only — React 19 removed the field. null otherwise. */
  sourceFile: string | null
}

/** Length caps, in characters or entries. A page can print anything; the prompt must stay a prompt. */
export const PICK_BUDGET = {
  textSnippet: 200,
  htmlSnippet: 4096,
  selector: 700,
  elementPath: 900,
  cssClasses: 500,
  nearbyTextEntries: 10,
  nearbyTextEntry: 200,
  reactComponents: 500,
  sourceFile: 500,
  tagName: 50,
  role: 50,
  styleValue: 200,
  accessibleName: 200,
  title: 200,
  url: 2000,
  comment: 2000
} as const

export const MAX_ANNOTATIONS = 20

/** What the remark is: an ask, or a question. Orca's pair, and for its reason -- four of these put a
 *  label on every row that says the same thing, and "fix" against "change" was a distinction the
 *  agent never acted on differently. The value travels to the prompt verbatim, so it stays English. */
export type Intent = 'change' | 'question'
export const INTENTS: readonly Intent[] = ['change', 'question']

export interface Annotation {
  id: string
  /** Badge number. Never reused within a tab — a comment saying "like 3" must stay true after a delete. */
  seq: number
  payload: PickPayload
  /** Absolute path of the cropped PNG, or null when the capture failed. */
  shotPath: string | null
  comment: string
  intent: Intent
  /** `new URL(payload.page.url).pathname`. Badges are drawn only while the tab is on this path. */
  pagePath: string
}

/** What main returns from preview.captureElement. */
export interface CaptureResult {
  path: string
  width: number
  height: number
}
