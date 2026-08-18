import { useEffect, useRef, useState } from 'react'
import { MarkdownPreview } from './MarkdownPreview'
import { clampSplitRatio, SPLIT_DEFAULT, type MdViewMode } from '../../../core/files/markdownView'
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
 *  툴바는 순환 버튼 하나가 아니라 라디오처럼 동작하는 세 버튼이고, 어느 모드에서든 셋 다 보인다 —
 *  에디터만 모드에서 툴바가 사라지면 돌아올 길이 없다. 키바인딩(explorer.cyclePreview, task 10)만
 *  순환한다.
 *
 *  프리뷰의 스크롤 컨테이너(`previewElRef`)는 이 컴포넌트가 직접 들고 App 으로 내보내지 않는다 —
 *  그것을 읽는 것은 task 9 의 스크롤 동기화뿐이고, 그 동기화도 이 컴포넌트 안에 산다. */
export function MarkdownSplit({
  mode,
  onModeChange,
  text,
  docPath,
  onOpenFile,
  onSave,
  editor
}: {
  mode: MdViewMode
  onModeChange: (mode: MdViewMode) => void
  text: string
  docPath: string
  onOpenFile: (absPath: string) => void
  onSave: () => void
  /** 왼쪽에 들어갈 것 — App 이 만든 FileEditor 를 그대로 받는다. 이 컴포넌트가 FileEditor 를
   *  직접 만들지 않는 이유는, 그 프롭이 열 개가 넘고 전부 App 의 상태에서 오기 때문이다 */
  editor: React.ReactNode
}): React.JSX.Element {
  const { t } = useI18n()
  const splitRef = useRef<HTMLDivElement>(null)
  /** 프리뷰의 스크롤 컨테이너. task 9 의 스크롤 동기화가 여기서 앵커를 읽는다 */
  const previewElRef = useRef<HTMLDivElement | null>(null)
  const [ratio, setRatio] = useState<number>(() =>
    clampSplitRatio(localStorage.getItem(RATIO_KEY) ?? SPLIT_DEFAULT)
  )

  // preview 모드로 "들어갈 때"만 포커스를 프리뷰 컨테이너로 옮긴다 — Mod+S 가 반응할 곳이 이곳뿐이기
  // 때문이다(CM6 의 키맵은 에디터가 display:none 인 동안 키를 볼 수 없다). split·editor 모드로 갈
  // 때는 아무것도 하지 않는다 — 에디터에 있던 포커스를 빼앗지 않는다. mode 가 계속 'preview'로 머무는
  // 동안(text 변경 등으로 리렌더가 일어나도) 이 effect 는 다시 뛰지 않는다 — 의존성이 mode 뿐이라서,
  // 사용자가 프리뷰 안의 링크 등으로 옮긴 포커스를 다시 빼앗지 않는다.
  // 되돌아가는 길: 사용자가 에디터 영역을 클릭하거나 Tab 으로 옮기면 된다 — 모드가 바뀌어 에디터가
  // 다시 보이는 것 자체는 포커스를 옮기지 않는다(에디터에 포커스를 강제하는 것도 "에디터의 포커스를
  // 빼앗지 않는다"는 규칙을 어기게 된다 — 사용자가 split/editor 로 돌아왔을 때 이미 다른 곳, 예를
  // 들어 방금 누른 툴바 버튼에 포커스가 있을 수 있고 그것도 존중해야 한다).
  useEffect(() => {
    if (mode === 'preview') previewElRef.current?.focus()
  }, [mode])

  // 드래그가 진행 중인지, 그리고 그 드래그가 등록한 window 리스너를 어떻게 떼어낼지.
  // draggingRef 는 "두 번째 포인터가 드래그 중에 눌리는" 경로를 막는다 — 그것을 막지 않으면 리스너가
  // 두 벌 등록되고, pointerId 를 가리지 않는 up() 이 서로 다른 포인터의 pointerup 에도 반응해 남의
  // 드래그를 조기에 끝내 버린다(리스너를 지우고 저장하는 것까지).
  // dragCleanupRef 는 "드래그 중 컴포넌트가 언마운트되는" 경로를 막는다 — 사이드바 리사이저에는 없는
  // 청소이지만, 여기서는 mode 전환만으로도 리사이저 DOM 자체가(그리고 이 컴포넌트 전체도, 예: 다른
  // 파일로 전환) 사라질 수 있어 그 경로를 열어 두지 않는다. 남겨 두면 실제 드래그가 끝난 뒤 이미 죽은
  // 클로저가 window 리스너로 계속 살아남아, setRatio·localStorage 를 향해 계속 쓰게 된다.
  const draggingRef = useRef(false)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => dragCleanupRef.current?.(), [])

  // 사이드바 리사이저(App.tsx)와 같은 방식 — 포인터 캡처로 끌고, 놓을 때 저장한다. pointercancel 도
  // pointerup 과 같은 핸들러로 받는다(같은 이유 — 사이드바·Run 패널 리사이저 모두 그렇게 한다):
  // 제스처가 OS/브라우저에 의해 취소돼도 마지막으로 계산된 비율은 그대로 커밋한다.
  const startDrag = (e: React.PointerEvent): void => {
    e.preventDefault()
    if (draggingRef.current) return
    const host = splitRef.current
    if (!host) return
    draggingRef.current = true
    const move = (ev: PointerEvent): void => {
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
    const up = (): void => {
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
      <div className="md-toolbar">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={mode === m.id ? 'active' : undefined}
            aria-pressed={mode === m.id}
            title={t(`files.markdown.mode.${m.id}`)}
            onClick={() => onModeChange(m.id)}
          >
            {m.glyph}
          </button>
        ))}
      </div>
      <div className="md-split" ref={splitRef} data-mode={mode}>
        <div
          className="md-pane md-pane-editor"
          style={mode === 'split' ? { flex: `0 0 ${ratio * 100}%` } : undefined}
          hidden={mode === 'preview'}
        >
          {editor}
        </div>
        {mode === 'split' && (
          <div
            className="md-resizer"
            onPointerDown={startDrag}
            role="separator"
            aria-orientation="vertical"
          />
        )}
        <div className="md-pane md-pane-preview" hidden={mode === 'editor'}>
          <MarkdownPreview
            text={text}
            docPath={docPath}
            onOpenFile={onOpenFile}
            onSave={onSave}
            scrollRef={previewElRef}
          />
        </div>
      </div>
    </div>
  )
}
