import * as pty from 'node-pty'
import { withExitedPtyGuard, type PtyFactory } from './pty'

export const nodePtyFactory: PtyFactory = (file, args, opts) => {
  const p = pty.spawn(file, args, { name: 'xterm-256color', ...opts })
  // 종료가 두 단계로 통지되는 탓에 끝난 PTY 로 간 write/resize 가 던지고, 그 예외가 ipcMain 핸들러
  // 밖으로 나가 main 프로세스를 죽인다 — 이유와 대가는 withExitedPtyGuard 의 주석에 있다.
  // node-pty 의 사정이므로 그것을 아는 유일한 파일인 여기서 감싼다: 이 팩토리를 받는 세 소비자
  // (RunManager/TerminalManager/SessionManager)가 각자 같은 try 를 두지 않아도 된다.
  return withExitedPtyGuard({
    pid: p.pid,
    onData: (cb) => {
      p.onData(cb)
    },
    onExit: (cb) => {
      p.onExit(cb)
    },
    write: (d) => p.write(d),
    resize: (c, r) => p.resize(c, r),
    kill: () => p.kill(),
    pause: () => p.pause(),
    resume: () => p.resume()
  })
}
