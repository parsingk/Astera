// Text guards over src/main/ipc.ts's convergence wiring, the same kind as
// src/main/lineNumberCitations.test.ts and src/main/packagedDeps.test.ts.
//
// **These guards are a scaffold, not the goal.** The real answer is to extract a wrapper into an
// importable unit a test can call — as Task 5 of the Host S2 plan did for startWorker, and as Tasks 6
// and 7 of the Host S4+S5 plan did for startValidation and startReview. Property 5 (no suspiciousFiles
// or policy snapshot on a Run without convergence) is now proven by
// src/core/orchestration/exec/validation.test.ts; Finding 1 (resultPath only on a converging Run) and
// ruling F63 (a gated Run gets no reviewer, and no review Dispatch is committed first) by
// src/core/orchestration/exec/review.test.ts. Their guards are gone from this file.
//
// Property 4 (a worker starts with the rolling chain built from its Task's own accounts) is now
// proven by src/core/orchestration/exec/workerStart.test.ts, and the guard below only pins that the
// startWorker wrapper calls startWorkerWithChain. It strips `//` comments only, so a call named
// inside a `/* */` block would still pass.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ipcSource = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ipc.ts'), 'utf8')

/** 두 표지 문자열 사이의 텍스트만 잘라낸다. 표지가 움직이거나 이름이 바뀌면 조용히 엉뚱한(또는
 *  파일 전체) 구간을 스캔하는 대신 여기서 바로 던진다. */
function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`marker not found in ipc.ts: ${JSON.stringify(startMarker)}`)
  const end = source.indexOf(endMarker, start + startMarker.length)
  if (end < 0) throw new Error(`end marker not found after start in ipc.ts: ${JSON.stringify(endMarker)}`)
  return source.slice(start, end)
}

/** `//` 줄 주석을 지운다 — 아래 검사들을 **코드**에 고정한다. 이것 없이는 "그 값을 계산해
 *  넘긴다"처럼 이 파일 자신이 남긴 설명 주석이 `indexOf`/정규식 검사를 코드 없이도 통과시킬 수
 *  있다. 이 두 구간에는 문자열 리터럴 안에 `//` 가 나오지 않으므로(경로는 백슬래시 없이 이 방식으로
 *  다루지 않는다) 줄 단위로 자르는 단순한 방식으로 충분하다.
 */
function stripLineComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const at = line.indexOf('//')
      return at === -1 ? line : line.slice(0, at)
    })
    .join('\n')
}

describe('ipc.ts convergence wiring (source guard)', () => {
  it('the startWorker wrapper hands every worker start to startWorkerWithChain (property 4)', () => {
    // deps.startWorker — every worker-start, repair (same-session reuse or fresh) and review Dispatch
    // goes through this one wrapper (repair.ts's RepairDeps.startWorker JSDoc names it explicitly).
    const wrapper = sliceBetween(ipcSource, 'startWorker: (a) =>', 'releaseWorker: async (')
    expect(stripLineComments(wrapper)).toMatch(/startWorkerWithChain\(/)
  })

  // N8: one `hostDrives()` closure in bootOrch, and every boot step that starts work asks it. The
  // behaviour each branch leads to is tested in yieldDispatch.test.ts and answerAct.test.ts; these pin
  // that ipc.ts reaches those seams through the one closure.
  it('the boot drain and the boot loop run only when the Host does not drive', () => {
    const boot = stripLineComments(sliceBetween(ipcSource, 'const bootOrch = async', 'releaseCoordinator = async'))
    expect(boot).toMatch(/const hostDrives = \(\): boolean => hostSpeaksDispatch\(/)
    expect(boot).toMatch(/if \(!hostDrives\(\)\)[\s\S]{0,400}applyPendingReports\(/)
    expect(boot).toMatch(/if \(!hostDrives\(\)\)[\s\S]{0,200}loop\.run\(\)/)
  })

  it('the resume sweeps, the loop, the timer, the forwarded starts and the stop button ask the one closure', () => {
    const boot = stripLineComments(sliceBetween(ipcSource, 'const bootOrch = async', 'releaseCoordinator = async'))
    expect(boot.match(/const hostDrives = /g)).toHaveLength(1)
    expect(boot).toMatch(/if \(!hostDrives\(\)\)[\s\S]{0,200}resumeSweep\.run\('this app started'\)/)
    expect(boot).toMatch(/if \(!hostDrives\(\)\)[\s\S]{0,200}resumeSweep\?\.run\('the Host attached'\)/)
    expect(boot).toMatch(/mayStart: \(\) => orch !== null && !hostDrives\(\)/)
    expect(boot).toMatch(/discardRunWorktree: appDiscardRunWorktree\(reapWorktree\)/)
    expect(boot).toMatch(/orchHostDrives = hostDrives/)
    const rest = stripLineComments(ipcSource.slice(ipcSource.indexOf('releaseCoordinator = async')))
    expect(rest).toMatch(/appTimerTick\(loop, \{ serving: orch !== null, hostDrives: hostDrives\(\)/)
    expect(rest).toMatch(/answerOrchAct\(\{ deps: orch\?\.deps \?\? null, act: m\.act, args: m\.args, yieldsDispatch: orchHostDrives\(\) \}\)/)
    const stop = stripLineComments(sliceBetween(ipcSource, "ipcMain.handle('run.stop'", "ipcMain.handle('run.dismiss'"))
    expect(stop).toMatch(/stopRunFromPanel\(\{[\s\S]*hostDrives: orchHostDrives\(\)/)
    expect(stop).toMatch(/cmd: 'validation-stop'/)
    expect(stop).not.toMatch(/core\.run\.stop\(runId\)\s*$/m)
  })
})
