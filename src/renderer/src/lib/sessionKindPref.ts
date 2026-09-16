import type { SessionKind } from '../../../core/types'

/** The new-session dialog's last choice — terminal or chat — remembered across dialog opens.
 *  Follows stickyProject.ts's pattern exactly: this is a display-only memory, so a storage failure
 *  (disabled, quota) is swallowed rather than thrown, and the fallback is always 'terminal' — the one
 *  kind every account and every Host can start, so a corrupt or missing value never strands the
 *  dialog on an option it cannot use.
 *
 *  Whether 'chat' is actually offered right now is not this module's question — the Host has to speak
 *  proc-* (useChatAvailability), and a resume also has to be on the account that holds the thread
 *  (resumeChatAllowed). Each dialog decides that for itself and falls back to 'terminal' in its own
 *  state when the remembered choice is not available. */

const KEY = 'newSession.kind'

export function read(): SessionKind {
  try {
    return localStorage.getItem(KEY) === 'chat' ? 'chat' : 'terminal'
  } catch {
    // 저장소가 꺼져 있는 경우 — 표시용 기억이므로 던지는 것보다 잊는 것이 낫다 (stickyProject.read 와 같은 이유)
    return 'terminal'
  }
}

export function write(kind: SessionKind): void {
  try {
    localStorage.setItem(KEY, kind)
  } catch {
    // 용량 초과나 저장소 비활성 — 이번 실행에서는 dialog state 가 값을 들고 있으므로 화면은 정상이고,
    // 재시작 후에만 잊는다 (stickyProject.write 와 같은 이유)
  }
}
