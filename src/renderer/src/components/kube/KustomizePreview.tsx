import { useEffect, useMemo, useState } from 'react'
import type { KubeRenderResult } from '../../../../core/kube/types'
import { docIdentity, patchLines, sameResource } from '../../../../core/kube/patchLines'
import { useI18n } from '../../i18n/I18nProvider'
import { Select } from '../Select'

/** One resource of the rendered output: its picker label and its own YAML text. */
export interface RenderedDoc {
  label: string
  text: string
}

/** `kubectl kustomize` output (re-stringified in main) as one entry per document, split at the `---` lines. */
export function splitRenderedDocs(text: string): RenderedDoc[] {
  const docs: RenderedDoc[] = []
  for (const part of text.split(/^---\r?\n/m)) {
    if (part.trim() === '') continue
    const id = docIdentity(part)
    docs.push({ label: id ? `${id.kind} · ${id.name}` : `#${docs.length + 1}`, text: part })
  }
  return docs
}

/** The document the open patch is written for (same kind, rendered name containing the patch's), else the first. */
export function defaultDocIndex(docs: RenderedDoc[], patchText: string): number {
  const patch = docIdentity(patchText)
  if (!patch) return 0
  const i = docs.findIndex((d) => {
    const id = docIdentity(d.text)
    return id !== null && sameResource(patch, id)
  })
  return i < 0 ? 0 : i
}

/**
 * `kubectl kustomize <overlay>` read only, with a resource picker and the lines the open patch sets tinted.
 * Renders again when `refreshKey` changes (a save of the file) or the overlay does. The "apply per overlay" note is
 * the toolbar's strip, not repeated here.
 */
export function KustomizePreview({
  overlayDir,
  patchText,
  refreshKey
}: {
  overlayDir: string
  patchText: string
  refreshKey: string | number
}): React.JSX.Element {
  const { t } = useI18n()
  const [result, setResult] = useState<KubeRenderResult | null>(null)
  const [picked, setPicked] = useState<number | null>(null)

  useEffect(() => {
    let current = true
    setResult(null)
    setPicked(null)
    window.api.kube
      .render(overlayDir)
      .then((r) => current && setResult(r))
      .catch((e: unknown) => current && setResult({ ok: false, stderr: e instanceof Error ? e.message : String(e) }))
    return () => {
      current = false
    }
  }, [overlayDir, refreshKey])

  const docs = useMemo(() => (result?.ok ? splitRenderedDocs(result.text) : []), [result])
  // The default follows the patch text as it is typed; a choice in the picker stays until the next render.
  const index = Math.min(picked ?? defaultDocIndex(docs, patchText), Math.max(docs.length - 1, 0))
  const doc = docs[index]
  const marked = useMemo(() => new Set(doc ? patchLines(patchText, doc.text) : []), [doc, patchText])

  return (
    <div className="kube-render">
      <div className="kube-render-head">
        <span className="kube-render-title">{t('kube.render.title')}</span>
        <span className="kube-render-badge">{t('kube.render.readOnly')}</span>
        {docs.length > 0 && (
          <span className="kube-sel-tip" title={t('kube.render.resource')}>
            <Select
              className="dense kube-sel kube-sel-render"
              ariaLabel={t('kube.render.resource')}
              items={docs.map((d, i) => ({ value: String(i), label: d.label }))}
              value={String(index)}
              onChange={(v) => setPicked(Number(v))}
              noCheck
            />
          </span>
        )}
        <span className="kube-render-legend">
          <span className="kube-render-swatch" />
          {t('kube.render.legend')}
        </span>
      </div>
      {result === null && <div className="kube-render-note">{t('kube.render.loading')}</div>}
      {result !== null && !result.ok && <pre className="kube-render-err">{result.stderr}</pre>}
      {result?.ok && !doc && <div className="kube-render-note">{t('kube.render.empty')}</div>}
      {doc && (
        <pre className="kube-render-body">
          {doc.text
            .replace(/\n$/, '')
            .split('\n')
            .map((line, i) => (
              <span key={i} className={marked.has(i + 1) ? 'kube-render-line hl' : 'kube-render-line'}>
                {line === '' ? ' ' : line}
              </span>
            ))}
        </pre>
      )}
    </div>
  )
}
