import { useEffect, useMemo, useRef, useState } from 'react'
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
import { resolveRelative } from '../../../core/files/paths'
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

/** Splits a code block into colored fragments. classHighlighter gives stable `tok-*` classes meant for
 *  external CSS — oneDarkHighlightStyle injects its own StyleModule when mounted as a CM6 extension, so
 *  there is no matching CSS for it outside an editor. */
function highlight(code: string, lang: LangKey | null): React.ReactNode {
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
    // local file, so it is cut off first.
    const clean = src.split(/[?#]/)[0]
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
  const blocks = useMemo(() => parseMarkdown(text), [text])
  const keyRef = useRef(0)
  keyRef.current = 0
  const nextKey = (): number => keyRef.current++

  const clickLink = (href: string, e: React.MouseEvent): void => {
    const target = classifyHref(href)
    if (!target) return
    e.preventDefault()
    if (target.kind === 'external') {
      void window.api.system.openExternal(target.url)
      return
    }
    if (target.kind === 'file') {
      const clean = target.path.split(/[?#]/)[0]
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
              // through to the browser's default of opening a new Electron window. Same gate as onClick.
              onAuxClick={(e) => clickLink(n.href, e)}
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
                onAuxClick={(e) => clickLink(n.attrs.href as string, e)}
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

  /** A heading's anchor id. A shortened version of GitHub's rule — lowercase, spaces become hyphens,
   *  everything else is dropped. */
  const slug = (nodes: MdInline[]): string =>
    nodes
      .map((n) => (n.k === 'text' || n.k === 'code' ? n.text : ''))
      .join('')
      .toLowerCase()
      .trim()
      .replace(/[^\w가-힣 -]/g, '')
      .replace(/\s+/g, '-')

  const renderBlocks = (list: MdBlock[]): React.ReactNode =>
    list.map((b) => {
      // data-md-line anchors scroll sync. It has to be on every block, without exception.
      const anchor = { 'data-md-line': b.line }
      switch (b.k) {
        case 'heading': {
          const Tag = `h${b.level}` as 'h1'
          return (
            <Tag key={nextKey()} id={`md-${slug(b.inline)}`} {...anchor}>
              {renderInline(b.inline)}
            </Tag>
          )
        }
        case 'para':
          return <p key={nextKey()} {...anchor}>{renderInline(b.inline)}</p>
        case 'code':
          return (
            <pre key={nextKey()} {...anchor}>
              <code>{highlight(b.text, b.lang)}</code>
            </pre>
          )
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
                    <input type="checkbox" checked={item.task} readOnly tabIndex={-1} />
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
      {blocks.length === 0 ? (
        <div className="md-preview-empty">{t('files.editor.selectPrompt')}</div>
      ) : (
        renderBlocks(blocks)
      )}
    </div>
  )
}
