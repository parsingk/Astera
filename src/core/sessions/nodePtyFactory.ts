import { execFile, fork } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import * as pty from 'node-pty'
import { treeKillCommand } from '../run/kill'
import { replaceConsoleProcessList } from './conptyConsoleList'
import { nodePtySpawnOptions, withExitedPtyGuard, type PtyFactory } from './pty'

export const nodePtyFactory: PtyFactory = (file, args, opts) => {
  const p = pty.spawn(file, args, nodePtySpawnOptions(opts))
  // node-pty 의 kill() 이 목록을 못 받았을 때 하는 맹목적 process.kill(셸 pid) 를 막는다 — 이유는 함수 주석에.
  try {
    replaceConsoleProcessList(p, process.platform, forkConsoleListAgent)
  } catch {
    // 교체는 덤이다: 실패해도 node-pty 원래 동작 그대로.
  }
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
    // No `remember`, deliberately: this pty is the app's own child and dies with the app, so there is
    // no later app to read a note back and nothing to remember it for. Callers reach it as
    // `pty.remember?.(…)`, so its absence is the no-op — the same way `meta` is ignored on the way in
    // (nodePtySpawnOptions), and the same reason: with no Host the app behaves exactly as it always
    // has.
  }, undefined, killTree)
}

/** node-pty 가 자기 `_getConsoleProcessList` 에서 fork 하는 것과 같은 에이전트(lib/conpty_console_list_agent.js).
 *  `createRequire(__filename)` 인 이유는 src/host/index.ts 의 ptyLibDir 와 같다: 번들되는 파일이라 번들러가
 *  건드리지 않는 형태를 쓴다. */
function forkConsoleListAgent(innerPid: number): ReturnType<typeof fork> {
  const lib = path.dirname(createRequire(__filename).resolve('node-pty'))
  return fork(path.join(lib, 'conpty_console_list_agent'), [String(innerPid)])
}

/** A repeat kill's escalation (withExitedPtyGuard): the process tree by pid, the taskkill /T /F RunManager
 *  already runs, which never touches the ConPTY handle. Nothing off win32: there node-pty's kill is a
 *  signal, and `treeKillCommand` answers null. Fire and forget; a process already gone is no failure. */
function killTree(pid: number): void {
  const cmd = treeKillCommand(process.platform, pid)
  if (cmd) execFile(cmd.file, cmd.args, { windowsHide: true }, () => {})
}
