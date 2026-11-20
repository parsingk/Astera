import { useEffect, useRef, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { stringify } from 'yaml'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { oneDark } from '@codemirror/theme-one-dark'
import { yaml } from '@codemirror/lang-yaml'
import { normalizeObject, type K8sObject } from '../../../../../core/kube/objects'
import { secretDisplay } from '../../../../../core/kube/cluster/secret'
import type { SecretValue } from '../../../../../core/kube/cluster/types'
import { useI18n } from '../../../i18n/I18nProvider'

export interface YamlReveal {
  /** The decoded values while shown; null while masked. */
  values: SecretValue[] | null
  onReveal(): void
  onHide(): void
}

/** The selected object as read-only YAML (spec 4.5). A Secret arrives masked from main; its values show only after an
 *  explicit click, and only the parent's state holds them. Before CodeMirror mounts (and in a static render) the same
 *  text is drawn as a plain block. */
export function KubeYamlView({ object, kind, reveal }: { object: K8sObject; kind: string; reveal: YamlReveal | null }): React.JSX.Element {
  const { t } = useI18n()
  const [serverFields, setServerFields] = useState(false)
  const [mounted, setMounted] = useState(false)
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)

  const text = stringify(normalizeObject(kind === 'Secret' ? secretDisplay(object, reveal?.values ?? null) : object, { keepServerFields: serverFields }))
  const binary = (reveal?.values ?? []).filter((v) => v.text === null).map((v) => v.key)

  useEffect(() => {
    if (host.current === null) return
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [basicSetup, oneDark, yaml(), EditorState.readOnly.of(true), EditorView.editable.of(false)]
      })
    })
    view.current = v
    setMounted(true)
    return () => {
      v.destroy()
      view.current = null
    }
    // The document is replaced below; the view is built once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const v = view.current
    if (v !== null && v.state.doc.toString() !== text) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } })
  }, [text])

  return (
    <div className="kube-yaml">
      <div className="kube-yaml-bar">
        <label className="kube-yaml-toggle">
          <input type="checkbox" checked={serverFields} onChange={(e) => setServerFields(e.target.checked)} />
          {t('kube.cluster.serverFields')}
        </label>
        {reveal !== null && (
          <button
            type="button"
            className="kube-btn kube-yaml-reveal"
            title={t(reveal.values === null ? 'kube.cluster.showValues' : 'kube.cluster.hideValues')}
            aria-label={t(reveal.values === null ? 'kube.cluster.showValues' : 'kube.cluster.hideValues')}
            onClick={reveal.values === null ? reveal.onReveal : reveal.onHide}
          >
            {reveal.values === null ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
        )}
      </div>
      {binary.length > 0 && (
        <div className="kube-yaml-note">
          {t('kube.cluster.binaryKeys')} {binary.join(', ')}
        </div>
      )}
      <div className="kube-yaml-host" ref={host} />
      {!mounted && <pre className="kube-yaml-plain">{text}</pre>}
    </div>
  )
}
