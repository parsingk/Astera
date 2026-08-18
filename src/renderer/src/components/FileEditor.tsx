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

/** 뷰마다의 소유자 — 그 뷰의 편집을 어디로 보낼지. **상태가 아니라 뷰에 매단다.**
 *
 *  편집 감지와 Ctrl+S 는 확장(extension)이고 확장은 EditorState 안에 산다. 그 확장이 인스턴스의
 *  콜백을 클로저로 붙잡으면, 캐시에 담긴 상태를 다른 페인의 뷰가 복원해 쓰는 순간 그 뷰의 편집이
 *  **상태를 만든 쪽의** 콜백을 부른다 — 한 페인에서 친 글자가 다른 파일에 기록되고 저장까지 그리로
 *  간다. 실제로 그렇게 다른 프로젝트의 파일이 덮어써졌다.
 *
 *  그래서 확장은 아무것도 붙잡지 않고, 호출 시점에 넘어오는 view 로 소유자를 찾는다. 상태를 페인
 *  사이로 옮기는 것이 이 설계의 핵심(되돌리기 보존)이므로, 상태 쪽을 인스턴스에서 떼어 내는 것이
 *  맞는 방향이다. */
interface EditorOwner {
  change: (text: string) => void
  save: () => void
}
const owners = new WeakMap<EditorView, EditorOwner>()

/** 어느 인스턴스도 붙잡지 않는 공통 확장. 그래서 이것이 든 상태는 어느 뷰에서든 안전하다 */
const sharedBase: Extension[] = [
  basicSetup,
  oneDark,
  keymap.of([
    indentWithTab,
    {
      key: 'Mod-s',
      preventDefault: true,
      run: (view) => {
        owners.get(view)?.save()
        return true
      }
    }
  ]),
  EditorView.updateListener.of((u) => {
    // Propagate user edits only: setState (a programmatic replacement) has an empty transactions array, so it is excluded
    if (u.docChanged && u.transactions.length > 0) owners.get(u.view)?.change(u.state.doc.toString())
  })
]

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
 *  whole explorer view down with it.
 *
 *  Its parent chain runs through MarkdownSplit's fixed skeleton for every file tab, markdown or not:
 *  `.md-split-host` > `.md-split` > `.md-pane-editor` > this component. MarkdownSplit.tsx's own comment
 *  explains why that skeleton never changes shape — the short version is that App used to render either
 *  `<MarkdownSplit/>` or `editor` directly, and switching between a `.md` and a non-`.md` file in the same
 *  pane swapped the element type at that spot, which unmounted and remounted this component and lost the
 *  undo history the paragraph above depends on. This component must keep sitting in exactly that slot. */
export function FileEditor({
  path,
  content,
  readOnly,
  cache,
  focused,
  onRetire,
  onChange,
  onSave,
  onViewChange
}: {
  path: string
  content: string
  readOnly: boolean
  /** 파일별 EditorState·스크롤 캐시. 소유자는 App이다 — 이 컴포넌트가 여러 개 생기더라도 되돌리기와
   *  스크롤이 살아남아야 하므로 인스턴스 안에 두지 않는다 */
  cache: EditorStateCache
  /** 이 페인이 활성이고 그 활성 탭이 이 파일인가. 참이 되는 순간 커서를 가져온다 — 탭을 다른 페인으로
   *  옮기거나 다른 페인의 파일 탭을 눌러도 커서가 옛 에디터에 남아 있으면, 이어서 친 글자가 화면에
   *  보이지 않는 다른 파일로 들어간다 */
  focused: boolean
  /** 이 에디터가 사라질 때 그 상태를 넘긴다. 캐시에 남길지는 App이 정한다 — 닫힌 파일의 상태를
   *  되살리면 안 되기 때문에 여기서 직접 저장하지 않는다 */
  onRetire: (path: string, state: EditorState, scroll: StateEffect<unknown> | null) => void
  /** 바뀐 텍스트와 **그 텍스트가 속한 경로**를 함께 넘긴다. 경로 없이 텍스트만 넘기면, 프롭이 새
   *  파일로 바뀐 뒤 뷰가 아직 옛 문서를 들고 있는 찰나의 편집이 새 파일의 내용으로 기록된다 — 그 창이
   *  실제로 다른 파일을 덮어썼다. 받는 쪽이 경로로 대상을 찾으면 그 오귀속이 구조적으로 불가능해진다 */
  onChange: (path: string, next: string) => void
  onSave: (path: string) => void
  /** 이 에디터의 EditorView 를 밖에 알린다. 마크다운 분할 뷰의 스크롤 동기화가 그 뷰의 스크롤
   *  위치와 줄 배치를 읽어야 해서 열어 둔 통로다. 마운트에서 뷰를, 언마운트에서 null 을 넘긴다.
   *  이 컴포넌트의 다른 규약은 아무것도 바뀌지 않는다 — 넘겨받은 쪽은 읽기만 한다. */
  onViewChange?: (view: EditorView | null) => void
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const curPathRef = useRef(path)
  // References to the latest callbacks — the base extensions are built only once, so this avoids staleness
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const onRetireRef = useRef(onRetire)
  onRetireRef.current = onRetire
  const onViewChangeRef = useRef(onViewChange)
  onViewChangeRef.current = onViewChange
  // 스크롤이 멈출 때마다 떠 두는 최신 스냅샷. 언마운트 정리 함수에서 읽으면 늦다 — 그 시점의 뷰는
  // 화면에서 떨어지는 중이라 위치가 0으로 읽힐 수 있고, 그러면 맨 위가 저장된다
  const lastScrollRef = useRef<StateEffect<unknown> | null>(null)

  // Create the EditorView once
  useEffect(() => {
    // 마운트에서도 캐시를 본다. 세션 모드로 나가면 이 컴포넌트가 언마운트되므로, 돌아왔을 때 되돌리기
    // 이력이 이어지려면 나갈 때 넘겨 둔 상태를 여기서 다시 집어야 한다
    const restored = restoreOrBuild(cache, sharedBase, path, content, readOnly)
    const view = new EditorView({ parent: hostRef.current!, state: restored.state })
    viewRef.current = view
    curPathRef.current = path
    // 이 뷰의 편집이 향할 곳. 경로는 호출 시점에 읽으므로 파일을 갈아타도 따라온다
    owners.set(view, {
      change: (text) => onChangeRef.current(curPathRef.current, text),
      save: () => onSaveRef.current(curPathRef.current)
    })
    onViewChangeRef.current?.(view)
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
      owners.delete(view)
      onRetireRef.current(curPathRef.current, view.state, lastScrollRef.current)
      onViewChangeRef.current?.(null)
      view.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 활성이 되면 커서를 가져온다. TerminalView 가 active 프롭으로 하는 것과 같은 규약이다.
  // path 도 의존성에 넣는 이유: 같은 페인이 활성인 채 파일만 바뀌는 경우(같은 탭 줄에서 다른 파일 탭을
  // 누름)에도 커서가 새 문서로 와야 하기 때문이다
  useEffect(() => {
    if (focused) viewRef.current?.focus()
  }, [focused, path])

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
      const restored = restoreOrBuild(cache, sharedBase, path, content, readOnly)
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
      view.setState(makeState(sharedBase, content, path, readOnly))
    } else if (view.state.readOnly !== readOnly)
      view.setState(makeState(sharedBase, content, path, readOnly))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, content, readOnly])

  return <div className="file-editor" ref={hostRef} />
}
