/** Confirmation modal store. Replaces window.confirm — the native modal halts the renderer synchronously
 *  and its OS chrome styling clashes with the app theme. It returns a promise, so existing flows keep
 *  working as `if (!(await confirmModal(...))) return`. Displaying it is ConfirmHost's job. */

/** 확인 창 안의 곁가지 선택 하나. 되돌릴 수 없는 동작에 딸린 결정을 그 자리에서 받는다 —
 *  "지울까?" 를 물으면서 "합칠까? 폴더도 지울까?" 를 따로 묻지 않게 한다. */
export type ConfirmChoice = {
  id: string
  label: string
  /** 라벨 아래 작게. 그 선택이 무엇을 잃게 하는지 적는 자리다 */
  hint?: string
  /** 이 선택이 속한 영역의 이름. 이어지는 같은 이름의 선택들이 그 이름 아래 한 영역으로 묶이고, 영역 사이에 선이
   *  그어진다(등록 창의 MCP 서버·스킬·플러그인). 없으면 줄마다 종류를 적지 않는 보통의 목록이다 */
  group?: string
  defaultChecked?: boolean
}
export type ConfirmRequest = {
  title: string
  body: string
  /** Drawn after the body in a code block, as it is: a command the person must see before it runs, as a Claude Code
   *  marketplace's (Claude plugin sharing §5.4). With it, Cancel has focus, so a stray Enter does not run the command. */
  code?: string
  /** Drawn after the choices, before the buttons: what to read last, as the plugin install warning's trust sentence
   *  (spec §31). */
  footer?: string
  confirmLabel?: string
  cancelLabel?: string
  choices?: ConfirmChoice[]
}
/** 확인 결과. checked 는 켜진 choice 의 id 들 — 취소면 언제나 빈 배열이다 */
export type ConfirmAnswer = { ok: boolean; checked: string[] }
export type PendingConfirm = ConfirmRequest & { resolve: (answer: ConfirmAnswer) => void }

const listeners = new Set<(pending: PendingConfirm | null) => void>()
let pending: PendingConfirm | null = null

function emit(): void {
  for (const listener of listeners) listener(pending)
}

export function subscribe(listener: (pending: PendingConfirm | null) => void): () => void {
  listeners.add(listener)
  listener(pending)
  return () => {
    listeners.delete(listener)
  }
}

/** For suppressing the global shortcuts — App's key handler checks this alongside modalOpenRef. */
export function isConfirmOpen(): boolean {
  return pending !== null
}

/** Takes the confirm/cancel answer as a promise. If one is already open it resolves as a cancel — so hammering a tab's ✕ does not stack modals. */
export function confirmModal(request: ConfirmRequest): Promise<boolean> {
  return confirmModalWithChoices(request).then((a) => a.ok)
}

/** choices 를 함께 묻는 확인 창. **confirmModal 을 그대로 둔 이유**: 호출부가 열 곳이고 대부분은
 *  boolean 하나로 끝나는 자리다(`if (!(await confirmModal(...))) return`) — 반환 타입을 바꾸면 이
 *  기능과 무관한 파일이 함께 고쳐진다. 저장소와 화면은 하나를 공유한다. */
export function confirmModalWithChoices(request: ConfirmRequest): Promise<ConfirmAnswer> {
  if (pending) return Promise.resolve({ ok: false, checked: [] })
  return new Promise<ConfirmAnswer>((resolve) => {
    pending = { ...request, resolve }
    emit()
  })
}

export function settle(ok: boolean, checked: string[] = []): void {
  const current = pending
  if (!current) return
  pending = null
  emit()
  // 취소는 언제나 빈 배열이다 — 켜 둔 체크박스가 취소를 타고 흘러나가면 부르는 쪽이 그것을 선택으로
  // 읽을 수 있다
  current.resolve({ ok, checked: ok ? checked : [] })
}
