import { useEffect, useRef } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { oneDark } from '@codemirror/theme-one-dark'
import { indentWithTab } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { json } from '@codemirror/lang-json'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { markdown } from '@codemirror/lang-markdown'
import { rust } from '@codemirror/lang-rust'
import { cpp } from '@codemirror/lang-cpp'
import { java } from '@codemirror/lang-java'
import { php } from '@codemirror/lang-php'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { go } from '@codemirror/lang-go'
import { languageForExt, type LangKey } from '../../../core/files/edit'

function langExt(key: LangKey | null): Extension {
  switch (key) {
    case 'javascript': return javascript({ jsx: true, typescript: true })
    case 'python': return python()
    case 'json': return json()
    case 'css': return css()
    case 'html': return html()
    case 'markdown': return markdown()
    case 'rust': return rust()
    case 'cpp': return cpp()
    case 'java': return java()
    case 'php': return php()
    case 'sql': return sql()
    case 'xml': return xml()
    case 'yaml': return yaml()
    case 'go': return go()
    default: return []
  }
}

// Builds the per-file EditorState — the editable/readOnly facets are baked straight into the state so
// each file's editability is reflected exactly (a switch replaces the whole thing via setState).
function makeState(base: Extension[], doc: string, path: string, readOnly: boolean): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      ...base,
      langExt(languageForExt(path)),
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly)
    ]
  })
}

/** CM6 file editor (a controlled component). The buffer, the dirty flag and the save policy are owned by
 *  App. The EditorState is cached per file so undo, the cursor and the scroll position survive a tab
 *  switch (the VS Code style). */
export function FileEditor({
  path,
  content,
  readOnly,
  onChange,
  onSave
}: {
  path: string
  content: string
  readOnly: boolean
  onChange: (next: string) => void
  onSave: () => void
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const baseRef = useRef<Extension[]>([])
  // Per-file-path EditorState and scroll cache — saved and restored on a tab switch
  const statesRef = useRef<Map<string, EditorState>>(new Map())
  const scrollRef = useRef<Map<string, number>>(new Map())
  const curPathRef = useRef(path)
  // References to the latest callbacks — the base extensions are built only once, so this avoids staleness
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  // Create the EditorView once
  useEffect(() => {
    baseRef.current = [
      basicSetup,
      oneDark,
      keymap.of([
        indentWithTab,
        { key: 'Mod-s', preventDefault: true, run: () => { onSaveRef.current(); return true } }
      ]),
      EditorView.updateListener.of((u) => {
        // Propagate user edits only: setState (a programmatic replacement) has an empty transactions array, so it is excluded
        if (u.docChanged && u.transactions.length > 0) onChangeRef.current(u.state.doc.toString())
      })
    ]
    const view = new EditorView({
      parent: hostRef.current!,
      state: makeState(baseRef.current, content, path, readOnly)
    })
    viewRef.current = view
    curPathRef.current = path
    return () => view.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Handling path/content/readOnly changes:
  //  - switching to a different file: save the previous state and scroll, then either restore the target
  //    file's state (only when the cache matches the current content) or build a new one
  //  - an external change to the same file (different content), or a readOnly change: apply a new state
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const prev = curPathRef.current
    if (prev !== path) {
      statesRef.current.set(prev, view.state)
      scrollRef.current.set(prev, view.scrollDOM.scrollTop)
      const cached = statesRef.current.get(path)
      const restorable = cached && cached.doc.toString() === content && cached.readOnly === readOnly
      view.setState(restorable ? cached : makeState(baseRef.current, content, path, readOnly))
      curPathRef.current = path
      const top = scrollRef.current.get(path)
      if (top != null) requestAnimationFrame(() => { if (viewRef.current === view) view.scrollDOM.scrollTop = top })
      return
    }
    if (view.state.doc.toString() !== content) view.setState(makeState(baseRef.current, content, path, readOnly))
    else if (view.state.readOnly !== readOnly) view.setState(makeState(baseRef.current, content, path, readOnly))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, content, readOnly])

  return <div className="file-editor" ref={hostRef} />
}
