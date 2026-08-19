import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { highlightCode, classHighlighter } from '@lezer/highlight'
import type { Language } from '@codemirror/language'
import { javascriptLanguage } from '@codemirror/lang-javascript'
import { pythonLanguage } from '@codemirror/lang-python'
import { jsonLanguage } from '@codemirror/lang-json'
import { cssLanguage } from '@codemirror/lang-css'
import { htmlLanguage } from '@codemirror/lang-html'
import { markdownLanguage } from '@codemirror/lang-markdown'
import { rustLanguage } from '@codemirror/lang-rust'
import { cppLanguage } from '@codemirror/lang-cpp'
import { javaLanguage } from '@codemirror/lang-java'
import { phpLanguage } from '@codemirror/lang-php'
import { StandardSQL } from '@codemirror/lang-sql'
import { xmlLanguage } from '@codemirror/lang-xml'
import { yamlLanguage } from '@codemirror/lang-yaml'
import { goLanguage } from '@codemirror/lang-go'
import {
  parseMarkdown, classifyHref,
  type MdBlock, type MdInline, type MdAttrs, type MdHref
} from '../../../core/files/markdownTree'
import type { LangKey } from '../../../core/files/edit'
import { resolveRelative, decodeUriPath } from '../../../core/files/paths'
import { useI18n } from '../i18n/I18nProvider'

/** LangKey → the Lezer language to parse with, standalone (outside a CodeMirror instance).
 *
 *  FileEditor imports the **extension factories** (javascript(), etc.) from the same packages — what
 *  is needed here is the parser, not the extension, so both call sites share the same packages without
 *  growing the bundle.
 *
 *  Why `Language` and not `LRLanguage`: 13 of these are `LRLanguage`, but `markdownLanguage` is a plain
 *  `Language` (markdown is not an LR parse). `Language` is the common supertype and `.parser.parse()`,
 *  the only thing used below, lives there. */
const LANGUAGES: Record<LangKey, Language> = {
  javascript: javascriptLanguage,
  python: pythonLanguage,
  json: jsonLanguage,
  css: cssLanguage,
  html: htmlLanguage,
  markdown: markdownLanguage,
  rust: rustLanguage,
  cpp: cppLanguage,
  java: javaLanguage,
  php: phpLanguage,
  sql: StandardSQL.language,
  xml: xmlLanguage,
  yaml: yamlLanguage,
  go: goLanguage
}

/** Above this size a fence is shown as plain text instead of highlighted. Measured directly against
 *  this file's own highlight(): a 200KB fence costs 87ms to parse and produces 118,719 <span>/text
 *  children in one <pre> — a 1MB fence (the files.readFile size bound) costs 412ms to parse and
 *  produces 593,639 children. Neither the parse cost nor a `<pre>` with that many DOM nodes is worth
 *  paying for a code sample; 100_000 sits at the top of the reviewed 50-100KB range, which still covers
 *  the large majority of real fenced examples people paste into a README. */
const HIGHLIGHT_MAX = 100_000

/** Splits a code block into colored fragments. classHighlighter gives stable `tok-*` classes meant for
 *  external CSS — oneDarkHighlightStyle injects its own StyleModule when mounted as a CM6 extension, so
 *  there is no matching CSS for it outside an editor. */
function highlight(code: string, lang: LangKey | null): React.ReactNode {
  if (code.length > HIGHLIGHT_MAX) return code
  const language = lang ? LANGUAGES[lang] : null
  if (!language) return code
  const out: React.ReactNode[] = []
  let key = 0
  highlightCode(
    code,
    language.parser.parse(code),
    classHighlighter,
    (text, classes) => {
      out.push(classes ? <span key={key++} className={classes}>{text}</span> : text)
    },
    () => out.push('\n')
  )
  return out
}

/** Highlight results, cached by content rather than by tree position.
 *
 *  CodeBlock's own React `key` comes from the shared positional counter (nextKey()), not from its
 *  content — so a structural edit anywhere earlier in the document (splitting a paragraph, adding
 *  emphasis, a new list item) shifts every key after it. React then unmounts the old CodeBlock fiber and
 *  mounts a fresh one for what is, content-wise, the exact same code block — discarding both memo's
 *  bailout and useMemo's cache, since neither survives past the fiber they live on. This cache does,
 *  because it lives at module scope rather than on any one fiber, so a remount for unchanged text+lang
 *  still hits it.
 *
 *  Capped at 64 entries, FIFO eviction (a Map preserves insertion order, so the oldest key is always
 *  `keys().next().value`). Unlike useMemo, nothing here is bounded by a fiber's own lifetime — an
 *  unbounded module cache would grow by one entry per distinct (lang, text) pair ever seen across a
 *  whole editing session, including every intermediate state of a fence being actively typed into. 64
 *  covers a document with an unusually large number of distinct code fences while keeping the cache's
 *  own footprint bounded (each entry is at most HIGHLIGHT_MAX characters of key text, since anything
 *  over that cap returns early below, before ever touching the cache).
 *
 *  Keyed on `${lang} ${code}`: no LangKey value contains a space or equals the literal string "null" (the
 *  template literal's stringification of the null case), so this cannot map two distinct (lang, code)
 *  pairs onto the same string. */
const HIGHLIGHT_CACHE_MAX = 64
const highlightCache = new Map<string, React.ReactNode>()

function cachedHighlight(code: string, lang: LangKey | null): React.ReactNode {
  if (code.length > HIGHLIGHT_MAX) return code
  const key = `${lang} ${code}`
  const cached = highlightCache.get(key)
  if (cached !== undefined) return cached
  const result = highlight(code, lang)
  highlightCache.set(key, result)
  if (highlightCache.size > HIGHLIGHT_CACHE_MAX) {
    const oldest = highlightCache.keys().next().value
    if (oldest !== undefined) highlightCache.delete(oldest)
  }
  return result
}

/** One fenced/indented code block. Wrapped in React.memo so that editing anywhere else in the document
 *  — which gives every block a brand-new object identity, since parseMarkdown rebuilds the whole tree —
 *  does not re-run cachedHighlight() for a block whose own text and language did not change within one
 *  render pass: memo's shallow prop comparison sees the same string values (strings compare by value)
 *  and bails out before this component's function body runs again. Props are kept to plain primitives
 *  (string, string|null, number) on purpose — an object or array prop here would be a new reference
 *  every render and defeat the comparison. useMemo is a second, cheaper line of defence for the rare
 *  case this instance does re-render (e.g. only `lang` changed) — it still saves the Map lookup itself.
 *  Neither of these survives the key-driven remount described above, which is what the module-level
 *  cachedHighlight() cache is for. */
const CodeBlock = memo(function CodeBlock({
  text, lang, line
}: {
  text: string
  lang: LangKey | null
  line: number
}): React.JSX.Element {
  const nodes = useMemo(() => cachedHighlight(text, lang), [text, lang])
  return (
    <pre data-md-line={line}>
      <code>{nodes}</code>
    </pre>
  )
})

/** Local image data URLs, cached by resolved absolute path.
 *
 *  LocalImage's React `key` comes from the shared positional counter (nextKey()), not from its content —
 *  so a structural edit anywhere earlier in the document (splitting a paragraph, adding emphasis, a new
 *  list item) shifts every key after it, exactly the remount hazard CodeBlock's cachedHighlight() above
 *  exists to survive. Without a module-scope cache, every image after the edit point unmounts (discarding
 *  its dataUrl state, which lives on the fiber) and remounts into the loading placeholder — a large layout
 *  jump (this repo's own banner alt is a full sentence) and a repeated IPC read for content that has not
 *  changed. Keying the cache by the resolved absolute path (rather than by `src`+`docPath`, the raw props)
 *  means a remount for a path already seen skips both.
 *
 *  Capped at 64 entries, FIFO eviction — the same bound and the same reasoning as highlightCache above (a
 *  Map preserves insertion order, so the oldest key is always `keys().next().value`). Unlike that cache,
 *  an entry here can be as large as IMAGE_READ_MAX (5MB, main/ipc.ts) once base64-encoded, so this cap is
 *  also what keeps a document with many large images from holding all of their data URLs in memory with
 *  no ceiling — there was no bound at all on that total before this cache existed.
 *
 *  Unlike highlightCache, a stale entry here is wrong, not just uncomputed: the file it was read from can
 *  change on disk. invalidateImageCache (below) is App's hook into this cache for exactly that — called
 *  from the same files:changed subscription that already reloads open text buffers, on every add/change/
 *  unlink chokidar reports for the watched project. */
const IMAGE_CACHE_MAX = 64
const imageDataUrlCache = new Map<string, string>()

/** Case-insensitive equality for two resolveImageSrc outputs. Exists because the cache key is never
 *  canonicalised to on-disk casing — resolveImageSrc (below) builds it by string surgery on the literal
 *  text the markdown author typed, not by walking the filesystem — while a files:changed path (main's
 *  FileWatcher, chokidar) reflects the actual on-disk entry name. On a case-preserving-but-insensitive
 *  filesystem (Windows NTFS, default macOS) those two strings can differ only in case for the exact same
 *  file — `assets/Diagram.PNG` in the markdown vs. `Diagram.png` chokidar reports — and a case-sensitive
 *  comparison would silently miss the invalidation. Lowercasing unconditionally, on every platform, is
 *  the same call this codebase already made for the same reason (isPathWithin's normalizePath,
 *  core/files/tree.ts, "win32-first: ignore differences in path case and separators") — on a genuinely
 *  case-sensitive filesystem (Linux) it is a harmless no-op, since a real casing mismatch there means
 *  the image never opened in the first place (fs.open is case-sensitive, so no cache entry would exist
 *  under the mismatched key to begin with). Separators are not normalised here: resolveImageSrc always
 *  uses docPath's own separator, and a files:changed path is native-separator too (fileWatcher.ts), so
 *  on any one platform both sides already agree.
 *
 *  Exported for its own unit test (Finding 2) — everywhere else in this file compares paths through this
 *  function rather than importing it directly. */
export function sameAbsPath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** Module-scope, per-path listeners a mounted LocalImage registers so invalidateImageCache can reach it.
 *  Deleting the Map entry alone would not do anything for an already-mounted LocalImage — its data URL
 *  lives in that instance's own React state, not re-read from the cache after mount. Notifying listeners
 *  is the second half of invalidation: it tells every live instance showing this path to drop its state
 *  and re-fetch, without forcing an unrelated re-render anywhere else in the tree. */
const imageInvalidationListeners = new Set<(absPath: string) => void>()

/** Called from App's files:changed subscription (main/fileWatcher.ts via chokidar) whenever a file the
 *  workspace watches is added, changed, or unlinked. Evicts every cache entry that resolves to the same
 *  file as `absPath` (sameAbsPath above — there is normally at most one, but nothing stops two documents
 *  from referencing the same image via different-case relative links) and tells any currently-mounted
 *  LocalImage showing it to re-fetch. A miss (no cache entry, no mounted image at this path) is the
 *  common case and costs one Map scan plus one Set iteration — cheap enough that the caller does not
 *  need to filter by extension or by "is this path actually referenced anywhere" first. */
export function invalidateImageCache(absPath: string): void {
  for (const key of imageDataUrlCache.keys()) if (sameAbsPath(key, absPath)) imageDataUrlCache.delete(key)
  for (const listener of imageInvalidationListeners) listener(absPath)
}

/** The document-relative src resolved to an absolute path, or '' for a disallowed/fragment-only one.
 *  Shared by LocalImage's cache lookup and its fetch effect so the two cannot compute it differently.
 *
 *  An anchor or query has no meaning for a local file, so it is cut off first (on the still-encoded
 *  string — decoding has to happen after that split, not before: see decodeUriPath's own note). A
 *  disallowed src (attrsFor already refused to keep it) or a fragment-only one (e.g. `![x](#foo)`) lands
 *  here as ''. Resolving that would just point at the document's own directory, which is never a valid
 *  image — the empty return is the caller's cue to fail straight away and skip a doomed IPC round trip. */
function resolveImageSrc(docPath: string, src: string): string {
  const clean = decodeUriPath(src.split(/[?#]/)[0])
  return clean ? resolveRelative(docPath, clean) : ''
}

/** One local image. Path validation happens in main, so this only turns a rejection into a message. */
function LocalImage({
  src, alt, title, docPath, style
}: {
  src: string
  alt: string
  title: string | null
  docPath: string
  style?: React.CSSProperties
}): React.JSX.Element {
  const { t } = useI18n()
  const abs = resolveImageSrc(docPath, src)
  // Lazy initializers so a cache hit shows the image on the very first render of a remount — without
  // this, a remount always paints the loading placeholder for one frame even for a path already cached.
  const [dataUrl, setDataUrl] = useState<string | null>(() => (abs ? imageDataUrlCache.get(abs) ?? null : null))
  const [failed, setFailed] = useState(() => !abs)
  // Bumped by the invalidation listener below to force the fetch effect to re-run even though `abs`
  // itself has not changed — the effect's own dependency array cannot see a change to module-scope
  // cache state.
  const [reloadTick, setReloadTick] = useState(0)
  // Registers for this instance's own abs path so an on-disk edit (App's files:changed → invalidateImageCache)
  // refetches this mounted image instead of leaving it showing the stale data URL from state until an
  // unrelated remount happens to discard it (Finding 2 — before this cache existed, a remount incidentally
  // refetched; the cache made that stop happening).
  useEffect(() => {
    if (!abs) return
    const onInvalidate = (changed: string): void => {
      if (sameAbsPath(changed, abs)) setReloadTick((n) => n + 1)
    }
    imageInvalidationListeners.add(onInvalidate)
    return () => {
      imageInvalidationListeners.delete(onInvalidate)
    }
  }, [abs])
  useEffect(() => {
    if (!abs) {
      setDataUrl(null)
      setFailed(true)
      return
    }
    // invalidateImageCache already deleted the stale entry before bumping reloadTick, so a cache hit
    // here only happens on a genuine remount (the abs-path-keyed lookup), never right after invalidation.
    const cached = imageDataUrlCache.get(abs)
    if (cached !== undefined) {
      setDataUrl(cached)
      setFailed(false)
      return
    }
    let cancelled = false
    setDataUrl(null)
    setFailed(false)
    void window.api.files
      .readDataUrl(abs)
      .then((r) => {
        imageDataUrlCache.set(abs, r.dataUrl)
        if (imageDataUrlCache.size > IMAGE_CACHE_MAX) {
          const oldest = imageDataUrlCache.keys().next().value
          if (oldest !== undefined) imageDataUrlCache.delete(oldest)
        }
        if (!cancelled) setDataUrl(r.dataUrl)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [abs, reloadTick])
  // style also goes on the placeholders — a raw <img width height> otherwise loses its reserved box
  // while loading (or on failure) and the surrounding layout jumps twice instead of once.
  if (failed) return <span className="md-img-failed" style={style}>{alt || t('files.markdown.image.failed')}</span>
  if (!dataUrl) return <span className="md-img-loading" style={style}>{alt}</span>
  return <img src={dataUrl} alt={alt} title={title ?? undefined} style={style} />
}

/** An http(s) image, loaded straight from its host.
 *
 *  **This costs privacy, and the trade was made deliberately.** Rendering the document is enough to make
 *  the request, so a file someone else wrote learns your IP, your user agent and the moment you opened it,
 *  and a per-recipient URL turns that into a read receipt. The preview refused these images at first for
 *  exactly that reason. It loads them now because a README's badge row is the single most common use of a
 *  remote image and a wall of placeholders where the badges belong reads as broken — the same call
 *  IntelliJ, VS Code and GitHub all make. Nothing executes either way: this is an `<img>`, not markup, and
 *  the URL still had to clear `classifyHref`'s scheme allowlist to reach here.
 *
 *  A failure falls back to the alt text rather than a broken-image glyph, matching LocalImage. `style`
 *  rides along so a raw `<img width height>` keeps its reserved box in both states and the surrounding
 *  layout settles once instead of twice. */
function RemoteImage({
  src, alt, title, style
}: {
  src: string
  alt: string
  title: string | null
  style?: React.CSSProperties
}): React.JSX.Element {
  const { t } = useI18n()
  const [failed, setFailed] = useState(false)
  // A new URL deserves a fresh attempt — without this, one failure would stick to every later src.
  useEffect(() => setFailed(false), [src])
  if (failed) return <span className="md-img-failed" style={style}>{alt || t('files.markdown.image.failed')}</span>
  return (
    <img src={src} alt={alt} title={title ?? undefined} style={style} onError={() => setFailed(true)} />
  )
}

/** Forces the switch below to cover every MdBlock/MdInline variant at compile time. React.ReactNode
 *  includes undefined, so without this default a switch missing a case for a newly added variant would
 *  just silently return undefined — no type error. Here, if a variant is left unhandled it fails to
 *  narrow to never, and this call itself becomes a type error, surfacing the missing case. */
function assertNever(x: never): never {
  throw new Error(`markdown preview: unhandled node ${JSON.stringify(x)}`)
}

function attrsToProps(attrs: MdAttrs): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  if (attrs.title !== undefined) props.title = attrs.title
  if (attrs.colspan !== undefined) props.colSpan = Number(attrs.colspan)
  if (attrs.rowspan !== undefined) props.rowSpan = Number(attrs.rowspan)
  if (attrs.start !== undefined) props.start = Number(attrs.start)
  if (attrs.open) props.open = true
  if (attrs.style) props.style = attrs.style
  return props
}

/** Whether a classified href should be shown as a remote-image placeholder. classifyHref's 'external'
 *  kind also covers `mailto:` — correct for a link, but not for an image src: `<img src="mailto:a@b.com">`
 *  has no business opening the mail client. Narrowing to http(s) here, instead of narrowing classifyHref
 *  itself, keeps `<a href="mailto:...">` working exactly as it does today — that gate is shared with
 *  links and has to stay as wide as links need. Anything that fails this (mailto, or no href at all)
 *  falls through to LocalImage, which then fails closed to the alt-text placeholder — never a launched
 *  external app — once it cannot resolve or read the "path". */
function isRemoteImage(target: MdHref): target is { kind: 'external'; url: string } {
  return target !== null && target.kind === 'external' && /^https?:/i.test(target.url)
}

/** Renders a raw-HTML `<img>` — RemoteImage for an http(s) src, LocalImage otherwise. The one thing
 *  both renderInline and renderBlocks call for a `tag === 'img'` htmlEl node, so the local/remote split
 *  cannot diverge between them the way the `<a>` handling below once did (Finding 1). */
function renderHtmlImg(attrs: MdAttrs, docPath: string, key: number): React.ReactNode {
  const src = attrs.src ?? ''
  const alt = attrs.alt ?? ''
  const target = classifyHref(src)
  if (isRemoteImage(target))
    return (
      <RemoteImage key={key} src={target.url} alt={alt} title={attrs.title ?? null} style={attrs.style} />
    )
  return (
    <LocalImage key={key} src={src} alt={alt} title={attrs.title ?? null} docPath={docPath} style={attrs.style} />
  )
}

/** Renders a raw-HTML `<a href>` with the same click handling as a markdown link — or null when there is
 *  no href (attrsFor already refused to keep one that failed classifyHref), which is the caller's cue to
 *  fall through to the generic, non-interactive Tag path instead.
 *
 *  The one thing both renderInline and renderBlocks call for a `tag === 'a'` htmlEl node. Before this was
 *  extracted, renderBlocks had no equivalent branch at all and fell straight to the generic path, which
 *  spreads attrsToProps(attrs) — and attrsToProps deliberately never carries `href` (Finding 1). A
 *  block-level `<a>` therefore rendered as an inert element with no href and no click handler; the two
 *  most common raw-HTML idioms in READMEs (`<a><img></a>` wrapped in `<div align>`/`<p align>`) are both
 *  block-level and both hit this. Routing both switches through this one function is what makes that
 *  divergence structurally impossible going forward, rather than merely commented against the way the
 *  two block/inline HTML-folding stacks (foldInline/blocksOf) already are for their own invariants.
 *
 *  `renderChildren` is a thunk, not an already-rendered node: this can return null before ever using it
 *  (no href), and both call sites fall back to rendering the same children again through the generic Tag
 *  path in that case — evaluating them eagerly here would render every descendant of a href-less <a>
 *  twice on every pass over it. */
function renderHtmlAnchor(
  attrs: MdAttrs,
  renderChildren: () => React.ReactNode,
  clickLink: (href: string, e: React.MouseEvent) => void,
  key: number,
  extraProps?: Record<string, unknown>
): React.ReactNode | null {
  const href = attrs.href
  if (!href) return null
  return (
    <a
      key={key}
      href={href}
      onClick={(e) => clickLink(href, e)}
      // Same auxclick gate as the markdown-link case below — only the middle button, so a right click's
      // contextmenu handling reaches the browser undisturbed.
      onAuxClick={(e) => {
        if (e.button === 1) clickLink(href, e)
      }}
      {...extraProps}
      {...attrsToProps(attrs)}
    >
      {renderChildren()}
    </a>
  )
}

export function MarkdownPreview({
  text, docPath, onOpenFile, onSave, scrollRef
}: {
  text: string
  /** This document's absolute path — the base a relative image or link resolves against. */
  docPath: string
  /** Fires when a relative link is clicked. Receives an absolute path. */
  onOpenFile: (absPath: string) => void
  /** Mod+S in preview-only mode. When the editor is display:none, its CM6 keymap cannot see the key. */
  onSave: () => void
  scrollRef: React.Ref<HTMLDivElement>
}): React.JSX.Element {
  const { t } = useI18n()
  // null means parseMarkdown threw — e.g. a pathologically nested document (thousands of '>' quote
  // markers) overflows the parser's own recursion, which is a parser-side limit this component cannot
  // fix. It runs inside this useMemo, i.e. during render, and this app has no ErrorBoundary anywhere —
  // an uncaught throw here would blank the entire window, not just the preview. This is the one surface
  // whose whole input is untrusted, so it is the one place that has to contain it.
  const blocks = useMemo<MdBlock[] | null>(() => {
    try {
      return parseMarkdown(text)
    } catch {
      return null
    }
  }, [text])
  const keyRef = useRef(0)
  keyRef.current = 0
  const nextKey = (): number => keyRef.current++
  // GitHub-style heading anchor dedup: the first heading to produce a given slug keeps it plain, later
  // ones get -1, -2, ... appended. Reset every render like keyRef, and read/written strictly in the
  // document order renderBlocks walks, so the numbering is deterministic for a given document.
  const slugSeenRef = useRef<Map<string, number>>(new Map())
  slugSeenRef.current.clear()

  const clickLink = (href: string, e: React.MouseEvent): void => {
    // Ahead of the classifyHref check, not after it: this is the last line of defence on the app's only
    // user-controlled <a href> surface. A rejected href is unreachable today (attrsFor and linkTarget
    // both already refuse to keep one that fails classifyHref), but if that ever changed, checking first
    // would let a rejected href fall through to the browser's default navigation instead of being blocked
    // here.
    e.preventDefault()
    const target = classifyHref(href)
    if (!target) return
    if (target.kind === 'external') {
      void window.api.system.openExternal(target.url)
      return
    }
    if (target.kind === 'file') {
      // Splitting on the still-encoded string first, then decoding: a filename that legitimately
      // contains a literal '#' or '?' is percent-encoded (%23/%3F) in the link — decoding first could
      // turn that into a real delimiter and truncate the path at the wrong point.
      const clean = decodeUriPath(target.path.split(/[?#]/)[0])
      onOpenFile(resolveRelative(docPath, clean))
      return
    }
    // Anchor — scroll to that heading within the preview
    const el = document.getElementById(`md-${target.id}`)
    el?.scrollIntoView({ block: 'start' })
  }

  const renderInline = (nodes: MdInline[]): React.ReactNode =>
    nodes.map((n) => {
      switch (n.k) {
        case 'text': return n.text
        case 'strong': return <strong key={nextKey()}>{renderInline(n.children)}</strong>
        case 'em': return <em key={nextKey()}>{renderInline(n.children)}</em>
        case 'del': return <del key={nextKey()}>{renderInline(n.children)}</del>
        case 'code': return <code key={nextKey()}>{n.text}</code>
        case 'br': return <br key={nextKey()} />
        case 'link':
          return (
            <a
              key={nextKey()}
              href={n.href}
              title={n.title ?? undefined}
              onClick={(e) => clickLink(n.href, e)}
              // A middle click fires auxclick, not click. Left alone, the relative href would fall
              // through to the browser's default of opening a new Electron window. Same gate as onClick,
              // but only for the middle button (1) — auxclick also fires for a right click (button 2),
              // which must reach the browser's own contextmenu handling undisturbed.
              onAuxClick={(e) => {
                if (e.button === 1) clickLink(n.href, e)
              }}
            >
              {renderInline(n.children)}
            </a>
          )
        case 'image': {
          const target = classifyHref(n.src)
          if (isRemoteImage(target))
            return <RemoteImage key={nextKey()} src={target.url} alt={n.alt} title={n.title} />
          return (
            <LocalImage key={nextKey()} src={n.src} alt={n.alt} title={n.title} docPath={docPath} />
          )
        }
        case 'htmlEl': {
          const key = nextKey()
          if (n.tag === 'img') return renderHtmlImg(n.attrs, docPath, key)
          if (n.tag === 'a') {
            const anchor = renderHtmlAnchor(n.attrs, () => renderInline(n.children), clickLink, key)
            if (anchor) return anchor
          }
          // No children (e.g. <br>, <hr>) renders without a children prop at all. React DOM throws for
          // a void element that receives one, even an empty array — this is not just a dev warning.
          const Tag = n.tag as 'span'
          return n.children.length === 0 ? (
            <Tag key={key} {...attrsToProps(n.attrs)} />
          ) : (
            <Tag key={key} {...attrsToProps(n.attrs)}>
              {renderInline(n.children)}
            </Tag>
          )
        }
        default:
          return assertNever(n)
      }
    })

  /** The plain text a heading (or link label) renders as, for building its anchor id. Recurses into
   *  every variant that carries children (strong/em/del/link/htmlEl) rather than only reading direct
   *  text/code children — `## **bold only**` used to slug to the empty string because the bold text
   *  lived one level deeper than this looked. */
  const inlineText = (nodes: MdInline[]): string =>
    nodes
      .map((n) => {
        switch (n.k) {
          case 'text': return n.text
          case 'code': return n.text
          case 'image': return n.alt
          case 'br': return ' '
          case 'strong': case 'em': case 'del': case 'link': case 'htmlEl':
            return inlineText(n.children)
          default:
            return assertNever(n)
        }
      })
      .join('')

  /** A shortened version of GitHub's slugify rule — lowercase, spaces become hyphens, everything else
   *  is dropped. */
  const slugify = (text: string): string =>
    text
      .toLowerCase()
      .trim()
      .replace(/[^\w가-힣 -]/g, '')
      .replace(/\s+/g, '-')

  /** GitHub-style dedup: the first heading with a given base slug (which can be the empty string, e.g.
   *  a heading that is only an image with no alt text) keeps it as-is; every later heading with the same
   *  base gets -1, -2, ... appended, so two same-titled sections never collide on one id and a link to
   *  the first one never silently lands on a later one instead. */
  const dedupeSlug = (base: string): string => {
    const seen = slugSeenRef.current
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base}-${count}`
  }

  const renderBlocks = (list: MdBlock[]): React.ReactNode =>
    list.map((b) => {
      // data-md-line anchors scroll sync. It has to be on every block, without exception.
      const anchor = { 'data-md-line': b.line }
      switch (b.k) {
        case 'heading': {
          const Tag = `h${b.level}` as 'h1'
          const id = dedupeSlug(slugify(inlineText(b.inline)))
          return (
            <Tag key={nextKey()} id={`md-${id}`} {...anchor}>
              {renderInline(b.inline)}
            </Tag>
          )
        }
        case 'para':
          return <p key={nextKey()} {...anchor}>{renderInline(b.inline)}</p>
        case 'code':
          return <CodeBlock key={nextKey()} text={b.text} lang={b.lang} line={b.line} />
        case 'hr':
          return <hr key={nextKey()} {...anchor} />
        case 'quote':
          return <blockquote key={nextKey()} {...anchor}>{renderBlocks(b.children)}</blockquote>
        case 'list': {
          const Tag = b.ordered ? 'ol' : 'ul'
          return (
            <Tag key={nextKey()} start={b.ordered ? b.start : undefined} {...anchor}>
              {b.items.map((item) => (
                <li key={nextKey()} data-md-line={item.line} className={item.task === null ? undefined : 'md-task'}>
                  {item.task !== null && (
                    // readOnly alone does not stop a checkbox from visually toggling on click before
                    // React's controlled re-render snaps it back — disabled is what actually blocks
                    // the click. readOnly stays too: it is what suppresses the dev warning about a
                    // checked prop with no onChange handler.
                    <input type="checkbox" checked={item.task} disabled readOnly tabIndex={-1} />
                  )}
                  {renderBlocks(item.children)}
                </li>
              ))}
            </Tag>
          )
        }
        case 'table':
          return (
            <div key={nextKey()} className="md-table-wrap" {...anchor}>
              <table>
                <thead>
                  <tr>
                    {b.header.map((cell, i) => (
                      <th key={nextKey()} style={{ textAlign: b.align[i] ?? undefined }}>
                        {renderInline(cell)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((row) => (
                    <tr key={nextKey()}>
                      {row.map((cell, i) => (
                        <td key={nextKey()} style={{ textAlign: b.align[i] ?? undefined }}>
                          {renderInline(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        case 'htmlEl': {
          const key = nextKey()
          if (b.tag === 'img')
            return (
              <p key={key} {...anchor}>
                {renderHtmlImg(b.attrs, docPath, nextKey())}
              </p>
            )
          if (b.tag === 'a') {
            const rendered = renderHtmlAnchor(
              b.attrs,
              () => renderBlocks(b.children),
              clickLink,
              key,
              anchor
            )
            if (rendered) return rendered
          }
          // A raw <table> gets the same overflow-x wrapper as a markdown-syntax one — without it, a wide
          // table scrolls the whole preview pane horizontally instead of just itself (the .md-table-wrap
          // CSS comment says exactly that must not happen, and until now only applied to the 'table'
          // MdBlock case above, not this raw-HTML one).
          if (b.tag === 'table')
            return (
              <div key={key} className="md-table-wrap" {...anchor}>
                <table {...attrsToProps(b.attrs)}>{renderBlocks(b.children)}</table>
              </div>
            )
          // No children (e.g. <br>, <hr>) renders without a children prop at all. React DOM throws for
          // a void element that receives one, even an empty array — this is not just a dev warning.
          const Tag = b.tag as 'div'
          return b.children.length === 0 ? (
            <Tag key={key} {...anchor} {...attrsToProps(b.attrs)} />
          ) : (
            <Tag key={key} {...anchor} {...attrsToProps(b.attrs)}>
              {renderBlocks(b.children)}
            </Tag>
          )
        }
        default:
          return assertNever(b)
      }
    })

  return (
    <div
      className="md-preview"
      ref={scrollRef}
      // Preview-only mode needs focus for Mod+S and PageUp/PageDown to work.
      // Mod+S lives only in the CM6 keymap with no global handler — unreachable while the editor is display:none.
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          onSave()
        }
      }}
    >
      {blocks === null ? (
        <div className="md-preview-notice">{t('files.markdown.renderError')}</div>
      ) : (
        // blocks.length === 0 means an open file with empty content — not "no file selected", which
        // is a different screen entirely. Render nothing rather than a misleading prompt for it.
        renderBlocks(blocks)
      )}
    </div>
  )
}
