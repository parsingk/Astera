import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { oneDark } from '@codemirror/theme-one-dark'
import { yaml } from '@codemirror/lang-yaml'

/** An object's YAML to edit (spec 4.6, P3): CodeMirror built once with `initial`, `onChange` told the whole text at every
 *  change. The text lives in the editor, so the parent keeps no copy per keystroke. Before CodeMirror mounts (and in a
 *  static render) `initial` is drawn as a plain block, as KubeYamlView does. */
export function KubeYamlEditor({ initial, onChange }: { initial: string; onChange(text: string): void }): React.JSX.Element {
  const [mounted, setMounted] = useState(false)
  const host = useRef<HTMLDivElement>(null)
  // The listener below is built once, so it reads the newest callback from here.
  const change = useRef(onChange)
  change.current = onChange

  useEffect(() => {
    if (host.current === null) return
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial,
        extensions: [
          basicSetup,
          oneDark,
          yaml(),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) change.current(u.state.doc.toString())
          })
        ]
      })
    })
    setMounted(true)
    return () => v.destroy()
    // The editor is built once; the text after that is the editor's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="kube-yaml">
      <div className="kube-yaml-host" ref={host} />
      {!mounted && <pre className="kube-yaml-plain">{initial}</pre>}
    </div>
  )
}
