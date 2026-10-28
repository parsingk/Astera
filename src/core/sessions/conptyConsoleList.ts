/** 목록 에이전트(node-pty 의 conpty_console_list_agent)의 모양 중 여기서 쓰는 것만 — child_process.fork 의 결과. */
export interface ConsoleListAgent {
  on(event: 'message', cb: (message: { consoleProcessList?: unknown } | undefined) => void): unknown
  on(event: 'disconnect' | 'error', cb: (...args: unknown[]) => void): unknown
  kill(): unknown
}

export type ForkConsoleListAgent = (innerPid: number) => ConsoleListAgent

/** node-pty 와 같은 5 초. */
const LIST_TIMEOUT_MS = 5000

/** Windows 의 ConPTY(DLL 없이) 에서 node-pty 의 `kill()` 이 하는 맹목적인 kill 을 없앤다.
 *
 *  node-pty 1.1.0 (lib/windowsPtyAgent.js) 의 kill() 은 `_getConsoleProcessList()` 로 콘솔의 프로세스 목록을
 *  받아 하나씩 process.kill 하고, 바로 이어서 pseudoconsole 을 닫는다. 목록은 자식 프로세스가
 *  AttachConsole(셸 pid) 로 읽는데, 콘솔이나 셸이 이미 없으면 그게 던지고("AttachConsole failed") 메시지 없이
 *  끝나서, 프로미스는 5 초 timeout 에서 `[innerPid]` 로 resolve 된다 — 그 뒤 process.kill(innerPid). 그 사이
 *  node-pty 의 종료 스레드가 셸 핸들을 닫았으므로(src/win/conpty.cc) 그 pid 는 이미 다른 프로세스의 것일 수
 *  있고, 그 프로세스가 죽는다. 여기서는 답이 오면 그 목록을, 답 없이 끝나면(exit/error/timeout) `[]` 를 낸다.
 *
 *  `[]` 로 충분한 이유: kill() 은 목록을 요청한 직후 pseudoconsole 을 닫고, 그러면 아직 붙어 있는 클라이언트
 *  애플리케이션 각각에 CTRL_CLOSE_EVENT 가 가며(ClosePseudoConsole 문서), 그 신호를 처리하는 루틴이 어떻게
 *  끝나든 시스템이 프로세스를 종료한다(HandlerRoutine 문서):
 *  https://learn.microsoft.com/windows/console/closepseudoconsole
 *  https://learn.microsoft.com/windows/console/handlerroutine
 *
 *  바꿀 수 없는 인스턴스(win32 가 아님, `_agent` 나 그 메서드가 없음, winpty, conpty DLL 경로)는 건드리지 않고
 *  false 를 돌려준다. 절대 던지지 않는다. */
export function replaceConsoleProcessList(term: unknown, platform: string, fork: ForkConsoleListAgent): boolean {
  if (platform !== 'win32') return false
  const agent = (term as { _agent?: Record<string, unknown> } | null | undefined)?._agent
  if (!agent || typeof agent !== 'object') return false
  if (typeof agent._getConsoleProcessList !== 'function') return false
  // node-pty 가 ConPTY 를 쓰고(_useConpty) DLL 없이(_useConptyDll) 쓸 때만 kill() 이 이 경로를 탄다.
  if (agent._useConpty !== true || agent._useConptyDll) return false
  if (typeof agent._innerPid !== 'number') return false

  agent._getConsoleProcessList = (): Promise<number[]> =>
    new Promise<number[]>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const settle = (list: number[]): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(list)
      }
      let child: ConsoleListAgent
      try {
        child = fork(agent._innerPid as number)
      } catch {
        settle([])
        return
      }
      child.on('message', (message) => {
        const l = message?.consoleProcessList
        settle(Array.isArray(l) ? (l as number[]) : [])
      })
      // 'exit' 가 아니라 'disconnect': 에이전트는 process.send 하고 process.exit 하는데, 'exit'(프로세스 핸들)과
      // 'message'(IPC 채널)의 도착 순서는 보장되지 않아 'exit' 가 먼저 오면 오는 중인 목록을 버리게 된다.
      // 'disconnect' 는 채널이 EOF 에 닿을 때 나오고, 그 전에 읽힌 메시지는 이미 nextTick 으로 예약돼 있어
      // 항상 그 뒤다(Node lib/internal/child_process.js 의 setupChannel: EOF 분기가 target.disconnect() →
      // process.nextTick(finish) 로 'disconnect' 를 낸다). 채널이 안 닫히는 에이전트는 timeout 이 맡는다.
      // https://nodejs.org/docs/latest-v24.x/api/child_process.html#event-disconnect
      child.on('disconnect', () => settle([]))
      child.on('error', () => settle([]))
      timer = setTimeout(() => {
        const wasSettled = settled
        settle([])
        if (!wasSettled) {
          try {
            child.kill()
          } catch {
            // 이미 끝난 에이전트
          }
        }
      }, LIST_TIMEOUT_MS)
    })
  return true
}
