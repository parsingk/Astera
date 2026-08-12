import { useEffect, useRef } from 'react'
import { EditorState, type Extension, type StateEffect } from '@codemirror/state'
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
import { languageForExt, sameDocument, type LangKey } from '../../../core/files/edit'
import type { EditorStateCache } from '../lib/editorStateCache'

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

/** 캐시에 쓸 수 있는 상태가 있으면 그것을, 없으면 새로 만든 상태를 돌려준다. 문서와 편집 가능 여부가
 *  지금 프롭과 같을 때만 재사용한다 — 파일이 디스크에서 바뀌었거나 읽기 전용 여부가 달라졌으면 옛
 *  상태는 화면에 맞지 않는다. 마운트와 파일 전환이 같은 규칙을 써야 해서 함수로 뽑았다. */
function restoreOrBuild(
  cache: EditorStateCache,
  base: Extension[],
  path: string,
  content: string,
  readOnly: boolean
): { state: EditorState; scroll: StateEffect<unknown> | null } {
  const cached = cache.get(path)
  const usable =
    cached && sameDocument(cached.state.doc.toString(), content) && cached.state.readOnly === readOnly
  // 상태를 재사용할 때만 스크롤도 되돌린다. 문서가 달라졌다면 그 위치는 더 이상 같은 곳을 가리키지 않는다
  return usable
    ? { state: cached.state, scroll: cached.scroll }
    : { state: makeState(base, content, path, readOnly), scroll: null }
}

/** CM6 file editor (a controlled component). The buffer, the dirty flag and the save policy are owned by
 *  App. The EditorState is cached per file so undo, the cursor and the scroll position survive a tab
 *  switch (the VS Code style) — and, through onRetire, an unmount as well: leaving editor mode takes the
 *  whole explorer view down with it. */
export function FileEditor({
  path,
  content,
  readOnly,
  cache,
  onRetire,
  onChange,
  onSave
}: {
  path: string
  content: string
  readOnly: boolean
  /** 파일별 EditorState·스크롤 캐시. 소유자는 App이다 — 이 컴포넌트가 여러 개 생기더라도 되돌리기와
   *  스크롤이 살아남아야 하므로 인스턴스 안에 두지 않는다 */
  cache: EditorStateCache
  /** 이 에디터가 사라질 때 그 상태를 넘긴다. 캐시에 남길지는 App이 정한다 — 닫힌 파일의 상태를
   *  되살리면 안 되기 때문에 여기서 직접 저장하지 않는다 */
  onRetire: (path: string, state: EditorState, scroll: StateEffect<unknown> | null) => void
  onChange: (next: string) => void
  onSave: () => void
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const baseRef = useRef<Extension[]>([])
  const curPathRef = useRef(path)
  // References to the latest callbacks — the base extensions are built only once, so this avoids staleness
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const onRetireRef = useRef(onRetire)
  onRetireRef.current = onRetire
  // 스크롤이 멈출 때마다 떠 두는 최신 스냅샷. 언마운트 정리 함수에서 읽으면 늦다 — 그 시점의 뷰는
  // 화면에서 떨어지는 중이라 위치가 0으로 읽힐 수 있고, 그러면 맨 위가 저장된다
  const lastScrollRef = useRef<StateEffect<unknown> | null>(null)

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
    // 마운트에서도 캐시를 본다. 세션 모드로 나가면 이 컴포넌트가 언마운트되므로, 돌아왔을 때 되돌리기
    // 이력이 이어지려면 나갈 때 넘겨 둔 상태를 여기서 다시 집어야 한다
    const restored = restoreOrBuild(cache, baseRef.current, path, content, readOnly)
    const view = new EditorView({ parent: hostRef.current!, state: restored.state })
    viewRef.current = view
    curPathRef.current = path
    if (restored.scroll) view.dispatch({ effects: restored.scroll })

    let scrollFrame: number | null = null
    const onScroll = (): void => {
      if (scrollFrame != null) cancelAnimationFrame(scrollFrame)
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = null
        lastScrollRef.current = view.scrollSnapshot()
      })
    }
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      view.scrollDOM.removeEventListener('scroll', onScroll)
      if (scrollFrame != null) cancelAnimationFrame(scrollFrame)
      onRetireRef.current(curPathRef.current, view.state, lastScrollRef.current)
      view.destroy()
    }
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
      // 저장 경로를 언마운트와 하나로 맞춘다. cache.save를 직접 부르면 방금 닫은 파일의 상태가
      // 되살아난다 — closeFileTab은 drop을 한 뒤 남은 탭으로 path만 바꾸므로 여기로 들어온다
      onRetireRef.current(prev, view.state, lastScrollRef.current)
      lastScrollRef.current = null
      const restored = restoreOrBuild(cache, baseRef.current, path, content, readOnly)
      view.setState(restored.state)
      curPathRef.current = path
      if (restored.scroll) view.dispatch({ effects: restored.scroll })
      return
    }
    // 같은 비교가 여기에도 걸린다. 문자열을 그대로 비교하면 CRLF 파일은 매 렌더 새 상태로 갈아치워져
    // 되돌리기 이력이 계속 날아간다
    if (!sameDocument(view.state.doc.toString(), content)) {
      // 문서가 바뀌었으니 들고 있던 스크롤 스냅샷은 다른 문서의 위치다. 버리지 않으면 다음 마운트에서
      // 엉뚱한 곳으로 스크롤한다
      lastScrollRef.current = null
      view.setState(makeState(baseRef.current, content, path, readOnly))
    } else if (view.state.readOnly !== readOnly)
      view.setState(makeState(baseRef.current, content, path, readOnly))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, content, readOnly])

  return <div className="file-editor" ref={hostRef} />
}
