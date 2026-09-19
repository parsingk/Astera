// 텍스트 가드 — src/main/ipc.ts 의 완료 수렴 배선 두 자리. src/main/lineNumberCitations.test.ts,
// src/main/packagedDeps.test.ts 와 같은 부류다: 이 자리의 회귀는 이 저장소의 어떤 유닛 테스트도 잡지
// 못한다 — ipc.ts 자신에는 테스트가 없고, convergence.integration.test.ts 의 가짜는 이 파일의
// 계약을 재구현한 것이지 ipc.ts 자신의 코드를 실행하는 것이 아니다(그 파일의 rig() 머리말 참고).
//
// **이 가드는 스캐폴드이지 목표가 아니다.** 진짜 답은 아래 두 래퍼(startWorker·startValidation)를
// Electron 에 얽매이지 않는, import 가능한 단위로 뽑아 진짜 유닛 테스트가 부를 수 있게 하는 것이다.
// 그 리팩터가 오기 전까지, 이 가드는 최소한 두 래퍼의 텍스트가 자신이 말하는 일을 실제로 하고
// 있는지를 — 사람의 리뷰가 놓칠 수 있는 자리에서 — 소리 내어 확인한다.
//
// **property 4 — 롤링 체인을 지닌 repair 워커는 이 기능의 첫머리 약속이고, 오늘 이 스위트에서 그것을
// 확인하는 유일한 자리다.** startWorker 래퍼가 rollChainFor 호출 자체를 지우거나, Task 자신의 계정이
// 아닌 다른 것을 넘기거나, 결과를 계산해 놓고 coordinator.startWorker 에 넘기지 않으면 — 리뷰로도,
// 어떤 유닛 테스트로도 잡히지 않는다.
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
  it('the startWorker wrapper attaches the rolling chain to the worker it actually starts (property 4)', () => {
    // deps.startWorker — every worker-start, repair (same-session reuse or fresh) and review Dispatch
    // goes through this one wrapper (repair.ts's RepairDeps.startWorker JSDoc names it explicitly).
    const wrapper = stripLineComments(sliceBetween(ipcSource, 'startWorker: async (a) => {', 'releaseWorker: async ('))

    // rollChainFor is asked with **this Task's own** accounts (`task.accountIds`) — not just the one
    // account being dispatched on right now (`taskAccountIds: [a.accountId]` would read as "the chain
    // exists" to a looser check while quietly being a chain of one, unable to survive a usage limit by
    // switching accounts).
    const rollChainCall = /rollChainFor\(\s*\{([\s\S]*?)\}\s*\)/.exec(wrapper)
    expect(rollChainCall, 'rollChainFor(...) call not found in the startWorker wrapper').not.toBeNull()
    expect(rollChainCall![1]).toMatch(/taskAccountIds\s*:\s*task\.accountIds\b/)

    // ...and its *result* is what feeds the chain variable — not a call left standing while the
    // variable it should have fed keeps its stale initial value (a `rollChainFor(...)` call with its
    // return value silently discarded compiles fine and this repo has no lint rule that would flag the
    // now-never-reassigned variable).
    const assignedFrom = /(?:const|let|var)\s+(\w+)\s*=\s*rollChainFor\(/.exec(wrapper)
    expect(assignedFrom, 'no variable is assigned from the result of rollChainFor(...)').not.toBeNull()
    const pickedVar = assignedFrom![1]
    expect(wrapper).toMatch(new RegExp(`rollAccountIds\\s*=\\s*${pickedVar}\\.chain\\b`))

    // ...and that chain variable actually reaches the coordinator. Deliberately loose on the rest of
    // the object literal (`{ ...a, rollAccountIds }` today) — requiring that *exact* shape would fail a
    // correct wrapper the day a third property is added there, and a guard that cries wolf on correct
    // code is a guard people delete.
    const startCall = /coordinator\.startWorker\(\s*\{([\s\S]*?)\}\s*\)/.exec(wrapper)
    expect(startCall, 'coordinator.startWorker(...) call not found in the startWorker wrapper').not.toBeNull()
    expect(startCall![1]).toMatch(/\.\.\.a\b/)
    expect(startCall![1]).toMatch(/\brollAccountIds\b/)
  })

  it('startValidation checks policyOf before anything writes suspiciousFiles (property 5)', () => {
    const wrapper = stripLineComments(
      sliceBetween(ipcSource, 'startValidation: ({ taskId, cwd }) => {', 'startReview: ({ taskId }) => {')
    )
    const policyAt = wrapper.indexOf('policyOf(')
    const writeAt = wrapper.indexOf('suspiciousFiles:')
    expect(policyAt, 'policyOf(...) not found in the startValidation wrapper').toBeGreaterThanOrEqual(0)
    expect(writeAt, 'a suspiciousFiles: write not found in the startValidation wrapper').toBeGreaterThanOrEqual(0)
    // the guard the whole non-convergence compatibility promise rests on: a Run without convergence
    // must return out of this wrapper before the line that writes suspiciousFiles is ever reached.
    expect(policyAt).toBeLessThan(writeAt)
  })
})
