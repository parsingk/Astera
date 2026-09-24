// Text guards over src/main/ipc.ts's convergence wiring, the same kind as
// src/main/lineNumberCitations.test.ts and src/main/packagedDeps.test.ts. The startValidation and
// startReview wrappers still live inside registerIpc, where no unit test reaches them, and
// convergence.integration.test.ts reimplements their contract rather than running ipc.ts (see its
// rig() header).
//
// **These guards are a scaffold, not the goal.** The real answer for property 5 is to extract
// startValidation into an importable unit a test can call, as Task 5 of the Host S2 plan did for
// startWorker. Until then, the guards check that the wrapper text does what it says.
// property 5 is now validation.test.ts.
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

  // 전체 브랜치 리뷰, Finding 1 — 이 브랜치의 유일한 무방비 진입점이었다: buildReviewSpecFile 에
  // resultPath 를 넘기는 이 한 자리가 policyOf(...) !== null 로 가려지지 않으면, convergence 가 없는
  // Run 의 검토자도 "구조화된 판정" 절을 받고 아무도 읽지 않는 .review.json 에 쓰라는 말을 듣는다.
  // coordinator.test.ts 는 buildReviewSpecFile 자신이 resultPath 없이 그 절을 붙이지 않는 것만
  // 확인한다 — 이 자리는 ipc.ts 가 실제로 그 값을 조건부로 넘기는지를 확인한다(ipc.ts 자신에는 다른
  // 유닛 테스트가 닿지 않는다, 파일 머리말 참고).
  it('the startReview wrapper only passes resultPath when policyOf(...) says this Run converges (Finding 1)', () => {
    const wrapper = stripLineComments(
      sliceBetween(
        ipcSource,
        'const startReview = async ({ taskId }: { taskId: string }): Promise<void> => {',
        'let started: { sessionId: string; cwd: string; specPath: string }'
      )
    )
    const buildAt = wrapper.indexOf('buildReviewSpecFile(')
    expect(buildAt, 'buildReviewSpecFile(...) not found in the startReview wrapper').toBeGreaterThanOrEqual(0)
    const resultPathAt = wrapper.indexOf('resultPath:')
    expect(resultPathAt, 'a resultPath: property not found in the startReview wrapper').toBeGreaterThanOrEqual(0)
    const policyAt = wrapper.indexOf('policyOf(')
    expect(policyAt, 'policyOf(...) not found in the startReview wrapper').toBeGreaterThanOrEqual(0)
    // policyOf(...) must gate resultPath itself, not just appear somewhere earlier in the function —
    // so it has to sit immediately before the resultPath: property, not merely before
    // buildReviewSpecFile(...)'s own call site (resultPath is one of that call's arguments).
    expect(policyAt).toBeLessThan(resultPathAt)
    expect(resultPathAt - policyAt).toBeLessThan(300)
    // and it must be the same predicate the rest of the branch uses — not a raw field test that a
    // hand-edited "convergence": null would fool (server.ts's run-start handover made exactly this
    // mistake before this fix).
    expect(wrapper.slice(policyAt, resultPathAt)).not.toMatch(/\.convergence\s*!==\s*undefined/)
  })

  // ruling F63 — 판정과 거절은 reviewGate 가 들고 있고 유닛 테스트가 거기 있다. 이 가드가 메우는
  // 격차는 하나뿐이지만 그것이 전부다: **ipc.ts 의 진짜 startReview 가 그것을 부르는가**, 그리고
  // 검토 Dispatch 를 열기 **전에** 부르는가. 뒤에 부르면 Dispatch 를 커밋하고 세션을 띄운 다음에야
  // 거절하는 것이 되어, 막으려던 지출이 이미 일어난다. convergence.integration.test.ts 의 rig 는
  // 같은 줄을 자기 복사본에 들고 있을 뿐 이 파일을 실행하지 않는다.
  it('the startReview wrapper asks the Run gates before it opens a review Dispatch (ruling F63)', () => {
    const wrapper = stripLineComments(
      sliceBetween(
        ipcSource,
        'const startReview = async ({ taskId }: { taskId: string }): Promise<void> => {',
        'let started: { sessionId: string; cwd: string; specPath: string }'
      )
    )
    const refuseAt = wrapper.indexOf('refuseIfRunGated(')
    expect(refuseAt, 'reviewGate.refuseIfRunGated(...) not found in the startReview wrapper').toBeGreaterThanOrEqual(0)
    // awaited, and its answer returns — a call whose boolean is dropped refuses nothing.
    expect(wrapper).toMatch(/if\s*\(\s*await\s+\w+\.refuseIfRunGated\(\s*\{\s*taskId\s*\}\s*\)\s*\)\s*return/)
    const openAt = wrapper.indexOf('openReviewDispatch(')
    expect(openAt, 'openReviewDispatch(...) not found in the startReview wrapper').toBeGreaterThanOrEqual(0)
    expect(refuseAt).toBeLessThan(openAt)
  })
})
