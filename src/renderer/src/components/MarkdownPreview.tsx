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
  type MdBlock, type MdInline, type MdAttrs
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
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    setDataUrl(null)
    setFailed(false)
    // Resolves the document-relative path to an absolute one. An anchor or query has no meaning for a
    // local file, so it is cut off first (on the still-encoded string — see decodeUriPath's own note on
    // why decoding has to happen after that split, not before).
    const clean = decodeUriPath(src.split(/[?#]/)[0])
    // A disallowed src (attrsFor already refused to keep it) or a fragment-only one (e.g. `![x](#foo)`)
    // lands here as ''. Resolving that would just point at the document's own directory, which is never
    // a valid image — failing straight away skips a doomed IPC round trip.
    if (!clean) {
      setFailed(true)
      return
    }
    const abs = resolveRelative(docPath, clean)
    void window.api.files
      .readDataUrl(abs)
      .then((r) => {
        if (!cancelled) setDataUrl(r.dataUrl)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [src, docPath])
  if (failed) return <span className="md-img-failed">{alt || t('files.markdown.image.failed')}</span>
  if (!dataUrl) return <span className="md-img-loading">{alt}</span>
  return <img src={dataUrl} alt={alt} title={title ?? undefined} style={style} />
}

/** A remote image is never shown — opening the document alone would otherwise signal an external host.
 *  IntelliJ allows `img-src *`; this preview does not. */
function RemoteImage({ src, alt }: { src: string; alt: string }): React.JSX.Element {
  const { t } = useI18n()
  return (
    <button
      type="button"
      className="md-img-remote"
      title={t('files.markdown.image.remote')}
      onClick={() => void window.api.system.openExternal(src)}
    >
      {alt || src}
    </button>
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
    const target = classifyHref(href)
    if (!target) return
    e.preventDefault()
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
          if (target?.kind === 'external')
            return <RemoteImage key={nextKey()} src={target.url} alt={n.alt} />
          return (
            <LocalImage key={nextKey()} src={n.src} alt={n.alt} title={n.title} docPath={docPath} />
          )
        }
        case 'htmlEl': {
          if (n.tag === 'img') {
            const src = n.attrs.src ?? ''
            const alt = n.attrs.alt ?? ''
            const target = classifyHref(src)
            if (target?.kind === 'external')
              return <RemoteImage key={nextKey()} src={target.url} alt={alt} />
            return (
              <LocalImage
                key={nextKey()}
                src={src}
                alt={alt}
                title={n.attrs.title ?? null}
                docPath={docPath}
                style={n.attrs.style}
              />
            )
          }
          if (n.tag === 'a' && n.attrs.href)
            return (
              <a
                key={nextKey()}
                href={n.attrs.href}
                onClick={(e) => clickLink(n.attrs.href as string, e)}
                onAuxClick={(e) => {
                  if (e.button === 1) clickLink(n.attrs.href as string, e)
                }}
                {...attrsToProps(n.attrs)}
              >
                {renderInline(n.children)}
              </a>
            )
          // No children (e.g. <br>, <hr>) renders without a children prop at all. React DOM throws for
          // a void element that receives one, even an empty array — this is not just a dev warning.
          const Tag = n.tag as 'span'
          return n.children.length === 0 ? (
            <Tag key={nextKey()} {...attrsToProps(n.attrs)} />
          ) : (
            <Tag key={nextKey()} {...attrsToProps(n.attrs)}>
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
          if (b.tag === 'img') {
            const src = b.attrs.src ?? ''
            const alt = b.attrs.alt ?? ''
            const target = classifyHref(src)
            return (
              <p key={nextKey()} {...anchor}>
                {target?.kind === 'external' ? (
                  <RemoteImage src={target.url} alt={alt} />
                ) : (
                  <LocalImage
                    src={src}
                    alt={alt}
                    title={b.attrs.title ?? null}
                    docPath={docPath}
                    style={b.attrs.style}
                  />
                )}
              </p>
            )
          }
          // No children (e.g. <br>, <hr>) renders without a children prop at all. React DOM throws for
          // a void element that receives one, even an empty array — this is not just a dev warning.
          const Tag = b.tag as 'div'
          return b.children.length === 0 ? (
            <Tag key={nextKey()} {...anchor} {...attrsToProps(b.attrs)} />
          ) : (
            <Tag key={nextKey()} {...anchor} {...attrsToProps(b.attrs)}>
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
