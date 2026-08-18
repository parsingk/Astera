import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { EditorView } from '@codemirror/view'
import { MarkdownPreview } from './MarkdownPreview'
import {
  clampSplitRatio, SPLIT_DEFAULT, topForLine, lineForTop, toAnchors,
  type MdViewMode, type ScrollAnchor
} from '../../../core/files/markdownView'
import { useI18n } from '../i18n/I18nProvider'

const RATIO_KEY = 'cm.md.splitRatio'

/** `` t(`files.markdown.mode.${m.id}`) `` 는 `MessageKey` 가 `keyof typeof ko`(평평한 리터럴
 *  유니온)임에도 실제로 타입을 통과한다(직접 tsc 로 확인) — `MdViewMode` 가 세 값짜리 닫힌 유니온이라
 *  템플릿 리터럴 타입이 세 조합으로 즉시 펼쳐지고, 그 세 문자열이 전부 `ko.ts` 에 이미 있는 키라서다.
 *  캐스트도, 따로 든 `key: MessageKey` 필드도 필요 없다. */
const MODES: { id: MdViewMode; glyph: string }[] = [
  { id: 'editor', glyph: '◫' },
  { id: 'split', glyph: '◪' },
  { id: 'preview', glyph: '▣' }
]

/** 모드 버튼 세 개와 좌우 분할.
 *
 *  **에디터를 언마운트하지 않는다.** 프리뷰 전용 모드에서도 `hidden` 속성(= display:none)으로만
 *  숨긴다 — 언마운트는 EditorView 를 destroy 하고 되돌리기 이력을 지운다(FileEditor 의 주석이
 *  지키는 규약, PaneGrid 의 lastFileOfPane 도 같은 이유로 display 만 쓴다).
 *
 *  **`markdown=false` 일 때도 이 컴포넌트가 항상 렌더된다 — App 은 더 이상 `{md ? <MarkdownSplit/> :
 *  editor}` 를 하지 않는다.** 그 삼항연산자가 5개 task 가 지켜온 "에디터를 언마운트하지 않는다"는
 *  규약을 가장 바깥에서 깨고 있었다: 같은 자리에서 엘리먼트 타입이 `MarkdownSplit`↔`FileEditor` 로
 *  바뀌면 리액트는 그 자리의 서브트리를 통째로 갈아치운다 — 같은 페인에서 `.md` 파일과 `.ts` 파일을
 *  오가기만 해도 FileEditor 가 매번 언마운트·재마운트되어 되돌리기 이력이 사라졌다. 고친 방법은
 *  `hidden` 을 다루는 이 컴포넌트의 기존 관례를 한 단계 밖으로 넓힌 것이다: `markdown` 이 거짓이면
 *  툴바·리사이저·프리뷰 패널을 렌더하지 않고(이 셋은 `editor` 가 앉은 자리의 형제일 뿐이라 빼도
 *  `editor` 의 위치·타입은 흔들리지 않는다), `.md-split-host > .md-split > .md-pane-editor` 골격은
 *  항상 그대로 유지해 `editor` 가 앉는 자리 자체는 절대 바뀌지 않는다. `key` 로 강제 재마운트를
 *  시키는 대안은 고르지 않았다 — 그것은 이 문제를 "피하는" 게 아니라 "매번 일으키는" 것이다.
 *
 *  툴바는 순환 버튼 하나가 아니라 라디오처럼 동작하는 세 버튼이고, 어느 모드에서든 셋 다 보인다 —
 *  에디터만 모드에서 툴바가 사라지면 돌아올 길이 없다. 키바인딩(explorer.cyclePreview, task 10)만
 *  순환한다.
 *
 *  프리뷰의 스크롤 컨테이너(`previewElRef`)는 이 컴포넌트가 직접 들고 App 으로 내보내지 않는다 —
 *  그것을 읽는 것은 task 9 의 스크롤 동기화뿐이고, 그 동기화도 이 컴포넌트 안에 산다. */
export function MarkdownSplit({
  markdown,
  mode,
  onModeChange,
  text,
  docPath,
  onOpenFile,
  onSave,
  editor,
  editorView
}: {
  /** 이 탭이 실제로 `.md`/`.markdown` 인가. 거짓이면 툴바·리사이저·프리뷰를 그리지 않고 `editor` 만
   *  그린다 — App 의 isMarkdownPath 결과를 그대로 받는다. 아래 모든 mode 기반 effect·렌더 분기는
   *  이 값으로 먼저 게이트된다: 마크다운이 아닌 파일에서는 모드라는 개념 자체가 의미가 없다. */
  markdown: boolean
  mode: MdViewMode
  onModeChange: (mode: MdViewMode) => void
  text: string
  docPath: string
  onOpenFile: (absPath: string) => void
  onSave: () => void
  /** 왼쪽에 들어갈 것 — App 이 만든 FileEditor 를 그대로 받는다. 이 컴포넌트가 FileEditor 를
   *  직접 만들지 않는 이유는, 그 프롭이 열 개가 넘고 전부 App 의 상태에서 오기 때문이다 */
  editor: React.ReactNode
  /** `editor` 가 감싸고 있는 FileEditor 의 실제 EditorView. 스크롤 동기화가 그 스크롤 위치와 줄
   *  배치를 읽고 쓰는 데 쓰고, 프리뷰를 벗어날 때 포커스를 되돌리는 데도 쓴다. `editor` 자체는
   *  불투명한 ReactNode 라 이 프롭 없이는 둘 다 할 수 없다 — App 이 FileEditor 의 onViewChange 로
   *  받은 뷰를 그대로 내려준다. 마운트 전/언마운트 후에는 null. */
  editorView: EditorView | null
}): React.JSX.Element {
  const { t } = useI18n()
  const splitRef = useRef<HTMLDivElement>(null)
  /** 프리뷰의 스크롤 컨테이너. task 9 의 스크롤 동기화가 여기서 앵커를 읽는다 */
  const previewElRef = useRef<HTMLDivElement | null>(null)
  const [ratio, setRatio] = useState<number>(() =>
    clampSplitRatio(localStorage.getItem(RATIO_KEY) ?? SPLIT_DEFAULT)
  )

  const anchorsRef = useRef<ScrollAnchor[]>([])
  /** 프로그램적 스크롤이 상대편의 핸들러를 다시 깨우는 것을 막는 창. 여기 없으면 두 패널이
   *  서로를 밀며 진동한다 */
  const suppressUntilRef = useRef(0)
  const frameRef = useRef<number | null>(null)

  /** 프리뷰의 (줄번호, offsetTop) 표를 다시 만든다. 레이아웃이 끝난 뒤여야 한다.
   *
   *  DOM 을 읽는 것(querySelectorAll·offsetTop)만 여기서 하고, 그 결과를 정렬·중복 제거해
   *  topForLine/lineForTop 이 기대하는 모양으로 만드는 순수 변환은 markdownView.ts 의 toAnchors 다 —
   *  DOM 을 만지지 않는 계산이라 그쪽에 두고 단위 테스트를 붙였다. */
  const rebuildAnchors = (): void => {
    const host = previewElRef.current
    if (!host) return
    const pairs: { line: number; top: number }[] = []
    for (const el of host.querySelectorAll<HTMLElement>('[data-md-line]'))
      pairs.push({ line: Number(el.dataset.mdLine), top: el.offsetTop - host.offsetTop })
    anchorsRef.current = toAnchors(pairs)
  }

  // 문서가 바뀌면 앵커가 옛 레이아웃의 것이다. 렌더 뒤에 다시 만든다
  // markdown 이 거짓이면 프리뷰 자체가 그려지지 않으므로(아래 렌더 참고) rebuildAnchors 는
  // previewElRef.current 가 없어 즉시 no-op 이지만, 매 키입력마다 rAF 를 예약하는 낭비까지 막으려고
  // 여기서 먼저 게이트한다.
  useEffect(() => {
    if (!markdown) return
    const id = requestAnimationFrame(rebuildAnchors)
    return () => cancelAnimationFrame(id)
  }, [markdown, text, mode, ratio])

  // 폭이 바뀌면 줄바꿈이 달라져 offsetTop 이 전부 움직인다
  useEffect(() => {
    if (!markdown) return
    const host = previewElRef.current
    if (!host || mode === 'editor') return
    const ro = new ResizeObserver(() => rebuildAnchors())
    ro.observe(host)
    return () => ro.disconnect()
  }, [markdown, mode])

  const suppressed = (): boolean => performance.now() < suppressUntilRef.current
  const suppress = (): void => {
    suppressUntilRef.current = performance.now() + 120
  }

  // 에디터 → 프리뷰
  useEffect(() => {
    if (!markdown || !editorView || mode !== 'split') return
    const scroller = editorView.scrollDOM
    const onScroll = (): void => {
      if (suppressed()) return
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current)
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        // 예약과 실행 사이에 프리뷰→에디터 동기화가 끼어들어 suppress() 를 걸었을 수 있다 — 그
        // 경우 여기서도 다시 확인해야 한다. 프리뷰→에디터 쪽은 이벤트 시점에 바로 동작하므로 이
        // 재확인이 필요 없지만, 이쪽은 rAF 로 미뤄지는 만큼 그 사이의 suppress() 를 놓칠 수 있다
        if (suppressed()) return
        const host = previewElRef.current
        if (!host) return
        const block = editorView.lineBlockAtHeight(scroller.scrollTop - editorView.documentTop)
        const line = editorView.state.doc.lineAt(block.from).number - 1 // CM6 는 1-기반
        suppress()
        host.scrollTop = topForLine(anchorsRef.current, line)
      })
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current)
    }
  }, [markdown, editorView, mode])

  // 프리뷰 → 에디터
  useEffect(() => {
    if (!markdown) return
    const host = previewElRef.current
    if (!host || !editorView || mode !== 'split') return
    const onScroll = (): void => {
      if (suppressed()) return
      const line = lineForTop(anchorsRef.current, host.scrollTop)
      const doc = editorView.state.doc
      const target = Math.min(Math.max(line + 1, 1), doc.lines) // 1-기반으로 되돌리고 범위를 자른다
      suppress()
      editorView.dispatch({
        effects: EditorView.scrollIntoView(doc.line(target).from, { y: 'start' })
      })
    }
    host.addEventListener('scroll', onScroll, { passive: true })
    return () => host.removeEventListener('scroll', onScroll)
  }, [markdown, editorView, mode])

  // display:none 이었던 에디터가 돌아오면 높이를 0 으로 읽은 상태다. 다시 재게 하지 않으면
  // 복귀 직후 첫 동기화가 어긋난다. markdown 이 거짓이면 에디터가 hidden 되는 경로 자체가 없으니
  // (아래 렌더 참고) 이 재측정은 필요 없다 — 게이트해 두지 않으면 매 마운트마다 의미 없이 돈다.
  useEffect(() => {
    if (!markdown || (mode !== 'editor' && mode !== 'split')) return
    editorView?.requestMeasure()
  }, [markdown, mode, editorView])

  // preview 모드로 "들어갈 때"만 포커스를 프리뷰 컨테이너로 옮긴다 — Mod+S 가 반응할 곳이 이곳뿐이기
  // 때문이다(CM6 의 키맵은 에디터가 display:none 인 동안 키를 볼 수 없다). split·editor 모드로 갈
  // 때는 아무것도 하지 않는다 — 에디터에 있던 포커스를 빼앗지 않는다. mode 가 계속 'preview'로 머무는
  // 동안(text 변경 등으로 리렌더가 일어나도) 이 effect 는 다시 뛰지 않는다 — 의존성이 mode 뿐이라서,
  // 사용자가 프리뷰 안의 링크 등으로 옮긴 포커스를 다시 빼앗지 않는다.
  // 되돌아가는 길: 사용자가 에디터 영역을 클릭하거나 Tab 으로 옮기면 된다 — 모드가 바뀌어 에디터가
  // 다시 보이는 것 자체는 포커스를 옮기지 않는다(에디터에 포커스를 강제하는 것도 "에디터의 포커스를
  // 빼앗지 않는다"는 규칙을 어기게 된다 — 사용자가 split/editor 로 돌아왔을 때 이미 다른 곳, 예를
  // 들어 방금 누른 툴바 버튼에 포커스가 있을 수 있고 그것도 존중해야 한다).
  //
  // 이전의 갭(task 8 이 남기고 task 9 가 닫음): mode 가 'preview'를 벗어나면 포커스를 들고 있던
  // .md-preview 서브트리가 hidden 이 될 수 있고, 숨겨진 요소는 포커스를 들고 있을 수 없어 브라우저가
  // document.body 로 blur 한다. 툴바 버튼 클릭으로 모드가 바뀌는 경로는 클릭 자체가 모드 커밋 전에
  // 포커스를 그 버튼으로 옮겨 놓아 이 경로를 타지 않지만, task 10 의 순환 키바인딩으로 preview 중에
  // 모드를 바꾸면 키보드 사용자가 document.body 에 남았을 것이다. 아래의 두 번째 effect가 이제
  // `editorView` 로 받은 EditorView 에 `view.focus()` 를 호출해 이 경로를 닫는다.
  useEffect(() => {
    if (markdown && mode === 'preview') previewElRef.current?.focus()
  }, [markdown, mode])

  // 위 effect 의 반대 방향: 'preview'를 실제로 "떠날 때" 포커스가 아직 프리뷰 서브트리 안에 있으면
  // 에디터로 되돌린다. prevModeRef 로 실제 전이(직전 모드가 'preview')만 걸러낸다 — 그냥
  // `mode !== 'preview'` 만 보면 mode 는 그대로인데 editorView 만 바뀌어(예: 에디터 마운트) 이
  // effect 가 다시 뛰는 경우에도 걸려, 위 effect 가 지키는 "mode 가 안 바뀌면 포커스를 빼앗지 않는다"는
  // 규칙을 어기게 된다.
  //
  // useLayoutEffect 인 이유: display:none 이 된 요소에서 포커스를 body 로 옮기는 focus fixup rule 은
  // (WHATWG HTML, whatwg/html PR #8392 — DOM 제거로 도는 동기 변형과 분리됐다) "update the rendering"
  // 단계에서 도는 변형이고, 그 단계는 HTML 이벤트 루프의 한 단계로서 스크립트가 실행 중이 아닐 때(no
  // script is running)에만 도달한다 — 즉 지금 실행 중인 태스크(리액트의 동기 커밋 + layout effect
  // 체인 전체)가 다 끝나야 브라우저가 거기 이를 수 있다. useLayoutEffect 는 그 커밋과 같은 스크립트
  // 실행 안에서 동기로 돌므로, 중간에 다른 곳으로 제어가 넘어가지 않는 한 fixup 이 돌 기회보다 반드시
  // 먼저 끝난다. 페인트 뒤로 미뤄지는 일반 useEffect 로 하면 그 사이 fixup 이 이미 지나갔을 수 있어,
  // 그 경우 아래 `host.contains(document.activeElement)` 가 항상 거짓이 되어 이 fix 가 조용히
  // 무력화된다. (실제 브라우저에서 계측해 확인하지는 않았다 — task 10 의 수동 검증 항목: 프리뷰
  // 모드에서 순환 키를 눌러 포커스가 body 가 아니라 에디터로 가는지 확인한다.)
  //
  // `editorView` 가 이 순간 null 이면 `editorView?.focus()` 는 아무 일도 하지 않아, 그 렌더에서는
  // body 로의 blur 갭이 다시 열린다. 마운트 시점에는 이 경우가 실제로 걱정할 필요가 없다 — 두 effect가
  // "같은 커밋에서 돈다"는 이유가 아니라(FileEditor 가 뷰를 넘기는 것은 별도의 passive useEffect 라
  // 페인트 뒤 별도 커밋에서 돈다), `prevModeRef` 가 최초 렌더의 `mode` 값으로 시작해서 마운트 시점의
  // `leftPreview` 는 `editorView` 가 null 이든 아니든 항상 거짓이기 때문이다.
  const prevModeRef = useRef(mode)
  useLayoutEffect(() => {
    const leftPreview = markdown && prevModeRef.current === 'preview' && mode !== 'preview'
    prevModeRef.current = mode
    if (!leftPreview) return
    const host = previewElRef.current
    if (host && host.contains(document.activeElement)) editorView?.focus()
  }, [markdown, mode, editorView])

  // 드래그가 진행 중인지, 그리고 그 드래그가 등록한 window 리스너를 어떻게 걸러내고 떼어낼지.
  // draggingRef 는 "두 번째 포인터가 이 리사이저 위에 내려와 startDrag 를 다시 부르는" 경로만 막는다
  // — 막지 않으면 리스너가 두 벌 등록된다. 이것만으로는 부족하다: 화면 다른 곳에서 발생한 무관한
  // 두 번째 포인터(예: 터치스크린의 다른 접점)는 이 리사이저에 내려오지 않고도 이미 등록된 window
  // 리스너로 pointermove/pointerup 이벤트를 그냥 흘려보낸다 — 그 경로는 startDrag 를 다시 부르지
  // 않으므로 draggingRef 가 볼 수 없다. 그래서 move/up 이 이벤트의 pointerId 를 시작한 포인터의
  // id(startId)와 직접 비교한다 — 아래 참고.
  // dragCleanupRef 는 "드래그 중 컴포넌트가 언마운트되는" 경로를 막는다 — 사이드바 리사이저에는 없는
  // 청소이지만, 여기서는 mode 전환만으로도 리사이저 DOM 자체가(그리고 이 컴포넌트 전체도, 예: 다른
  // 파일로 전환) 사라질 수 있어 그 경로를 열어 두지 않는다. 남겨 두면 실제 드래그가 끝난 뒤 이미 죽은
  // 클로저가 window 리스너로 계속 살아남아, setRatio·localStorage 를 향해 계속 쓰게 된다.
  const draggingRef = useRef(false)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => dragCleanupRef.current?.(), [])

  // 사이드바 리사이저(App.tsx)와 같은 방식 — window 에 pointermove/pointerup 리스너를 걸어 두고,
  // 놓을 때 저장한다. (포인터 캡처가 아니다 — setPointerCapture 를 부르지 않는다. 그래서 move/up
  // 둘 다 이벤트의 pointerId 가 이 드래그를 시작한 포인터(startId)와 같은지 먼저 확인한다 — 다른
  // 포인터가 window 로 보낸 pointermove/pointerup/pointercancel 은 무시한다.) pointercancel 도
  // pointerup 과 같은 핸들러로 받는다(같은 이유 — 사이드바·Run 패널 리사이저 모두 그렇게 한다):
  // 제스처가 OS/브라우저에 의해 취소돼도 마지막으로 계산된 비율은 그대로 커밋한다.
  const startDrag = (e: React.PointerEvent): void => {
    e.preventDefault()
    if (draggingRef.current) return
    const host = splitRef.current
    if (!host) return
    draggingRef.current = true
    const startId = e.pointerId
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== startId) return
      const box = host.getBoundingClientRect()
      // 폭이 0인 프레임(모드 전환 직후)에서는 NaN 이 나온다. clampSplitRatio 가 기본값으로 되돌린다
      setRatio(clampSplitRatio((ev.clientX - box.left) / box.width))
    }
    const cleanup = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      draggingRef.current = false
      dragCleanupRef.current = null
    }
    const up = (ev: PointerEvent): void => {
      if (ev.pointerId !== startId) return
      cleanup()
      setRatio((r) => {
        localStorage.setItem(RATIO_KEY, String(r))
        return r
      })
    }
    dragCleanupRef.current = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  return (
    <div className="md-split-host">
      {/* markdown 이 거짓인 파일에는 툴바가 없다 — 안 그려지는 것이지, css 로 숨겨지는 게 아니다.
          이 div 는 .md-split-editor 의 형제일 뿐이라 있고 없고가 아래 .md-pane-editor 의 자리·타입에는
          영향을 주지 않는다 — FileEditor 는 그대로 마운트 상태를 유지한다. */}
      {markdown && (
        <div className="md-toolbar">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={mode === m.id ? 'active' : undefined}
              aria-pressed={mode === m.id}
              // 글리프 하나뿐인 버튼이라 텍스트 콘텐츠가 접근성 이름이 되어 주지 못한다 — title 과
              // aria-label 을 같은 문구로 같이 주는 것은 이 앱의 아이콘 전용 버튼 관례
              // (App.tsx 의 rail-btn, WorktreePanel 의 icon-btn 등) 을 그대로 따른 것이다.
              title={t(`files.markdown.mode.${m.id}`)}
              aria-label={t(`files.markdown.mode.${m.id}`)}
              onClick={() => onModeChange(m.id)}
            >
              {m.glyph}
            </button>
          ))}
        </div>
      )}
      <div className="md-split" ref={splitRef} data-mode={markdown ? mode : 'editor'}>
        {/* markdown 이 거짓이든 참이든 이 자리는 항상 같은 타입(div.md-pane.md-pane-editor)이고
            {editor} 는 항상 그 자리 그대로다 — 이 컴포넌트 자체도 App 에서 항상 렌더된다(더 이상
            {md ? <MarkdownSplit/> : editor} 삼항연산자가 없다). 그래서 파일이 .md 와 비-.md 사이를
            오가도 FileEditor 의 부모 체인이 어느 지점에서도 타입이 바뀌지 않고, 리액트가 그 서브트리를
            언마운트할 이유가 없다. */}
        <div
          className="md-pane md-pane-editor"
          style={markdown && mode === 'split' ? { flex: `0 0 ${ratio * 100}%` } : undefined}
          hidden={markdown && mode === 'preview'}
        >
          {editor}
        </div>
        {markdown && mode === 'split' && (
          <div
            className="md-resizer"
            onPointerDown={startDrag}
            role="separator"
            aria-orientation="vertical"
          />
        )}
        {markdown && (
          <div className="md-pane md-pane-preview" hidden={mode === 'editor'}>
            <MarkdownPreview
              text={text}
              docPath={docPath}
              onOpenFile={onOpenFile}
              onSave={onSave}
              scrollRef={previewElRef}
            />
          </div>
        )}
      </div>
    </div>
  )
}
