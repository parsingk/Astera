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
// 확인하는 유일한 자리다.** startWorker 래퍼가 rollChainFor 호출 자체를 지우거나, 그 결과를 계산해
// 놓고 coordinator.startWorker 에 넘기지 않으면 — 리뷰로도, 어떤 유닛 테스트로도 잡히지 않는다.
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

describe('ipc.ts convergence wiring (source guard)', () => {
  it('the startWorker wrapper attaches the rolling chain to the worker it actually starts (property 4)', () => {
    // deps.startWorker — every worker-start, repair (same-session reuse or fresh) and review Dispatch
    // goes through this one wrapper (repair.ts's RepairDeps.startWorker JSDoc names it explicitly).
    const wrapper = sliceBetween(ipcSource, 'startWorker: async (a) => {', 'releaseWorker: async (')

    // rollChainFor is asked with this Task's own accounts, not just the one account being dispatched
    // on right now — a repair worker that only ever got `[a.accountId]` could never survive a usage
    // limit by switching accounts.
    const rollChainCall = /rollChainFor\(\s*\{([\s\S]*?)\}\s*\)/.exec(wrapper)
    expect(rollChainCall, 'rollChainFor(...) call not found in the startWorker wrapper').not.toBeNull()
    expect(rollChainCall![1]).toContain('taskAccountIds')

    // ...and what rollChainFor computed actually reaches the coordinator — not a chain built and then
    // dropped on the floor before the session is spawned.
    expect(wrapper).toMatch(/coordinator\.startWorker\(\s*\{\s*\.\.\.a,\s*rollAccountIds\s*\}\s*\)/)
  })

  it('startValidation checks policyOf before anything writes suspiciousFiles (property 5)', () => {
    const wrapper = sliceBetween(
      ipcSource,
      'startValidation: ({ taskId, cwd }) => {',
      'startReview: ({ taskId }) => {'
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
