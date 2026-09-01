import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { OpenSessionTask } from '../../../core/types'
import type { ProjectUnderstanding, RecordExplanation, WorkRecord } from '../../../core/understanding/types'
import { UnderstandingView } from './UnderstandingView'

// MarkdownPreview.test.ts 와 같은 이유 — I18nProvider 의 효과는 renderToStaticMarkup 에서 돌지 않고
// 실제 window.api 도 없다. 훅을 직접 갈아 끼우는 것이 jsdom 없이 진짜 렌더를 보는 방법이다.
vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string) => key,
    tm: (m: unknown) => (m === null ? null : String(m))
  })
}))

const rec = (over: Partial<WorkRecord> = {}): WorkRecord => ({
  id: 'r1',
  at: '2026-08-31T01:00:00.000Z',
  source: { kind: 'session', sessionId: 's1', label: '세션 abcd1234' },
  request: '한도 감지를 고쳐줘',
  changedFiles: ['src/a.ts'],
  git: { startHead: 'a', endHead: 'b' },
  status: 'ready',
  ...over
})

const task = (over: Partial<OpenSessionTask> = {}): OpenSessionTask => ({
  id: 't1',
  objective: '한도 감지 조사',
  status: 'active',
  startedAt: '2026-08-31T01:00:00.000Z',
  sessionId: 's1',
  ...over
})

const render = (
  u: ProjectUnderstanding | null,
  selectedRecordId: string | null = null,
  openTasks: OpenSessionTask[] = []
): string =>
  renderToStaticMarkup(
    React.createElement(UnderstandingView, {
      understanding: u,
      selectedRecordId,
      onOpenRecord: () => {},
      onRegenerate: () => {},
      openTasks,
      onCompleteTask: () => {},
      onCancelTask: () => {}
    })
  )

describe('UnderstandingView', () => {
  it('기록이 없으면 빈 상태를 그린다', () => {
    expect(render({ records: [] })).toContain('hiw.empty.body')
  })

  it('기록 한 줄에 날짜·요청·출처가 있다', () => {
    const html = render({ records: [rec()] })
    expect(html).toContain('8/31')
    expect(html).toContain('한도 감지를 고쳐줘')
    expect(html).toContain('세션 abcd1234')
  })

  // 디스크에 이미 있는 기록들의 진짜 모양 — explanation 자체가 없는 것과는 다른 경로다(final
  // review, item 7): title 필드가 이 자리에 생기기 전에 만들어진 explanation 은 title 만 없다
  it('설명은 있어도 title 이 없으면 줄 제목은 원문으로 돌아간다', () => {
    const noTitle: RecordExplanation = {
      overview: '한도 대화상자를 신호로 삼도록 바꿨다.',
      userVisibleChanges: [],
      flow: [],
      decisions: [],
      implementation: [],
      evidence: [],
      userEdited: false,
      generatedAt: '2026-08-31T01:00:00.000Z'
    }
    const html = render({ records: [rec({ explanation: noTitle })] })
    expect(html).toContain('한도 감지를 고쳐줘')
  })

  it('Job 기록은 그 Job 이름을 출처로 보인다', () => {
    const html = render({
      records: [rec({ source: { kind: 'job', runId: 'run1', jobName: '단축키 붙이기', taskIds: ['t1'] } })]
    })
    expect(html).toContain('단축키 붙이기')
  })

  // 3~4분 걸린다 — 멈춘 화면과 죽은 화면은 같아 보인다
  it('만드는 중인 줄은 돈다', () => {
    expect(render({ records: [rec({ status: 'generating' })] })).toContain('hiw-spin')
  })

  it('만들지 못한 줄은 사유와 [다시] 를 보인다', () => {
    const html = render({ records: [rec({ status: 'failed', reason: '600초 안에 끝나지 않았다' })] })
    expect(html).toContain('600초 안에 끝나지 않았다')
    expect(html).toContain('hiw.record.regenerate')
  })

  it('검토가 필요한 줄도 사유와 [다시] 를 보인다', () => {
    const html = render({ records: [rec({ status: 'needs-review', reason: '커밋을 찾지 못했다' })] })
    expect(html).toContain('커밋을 찾지 못했다')
    expect(html).toContain('hiw.record.regenerate')
  })

  // NO_GENERATOR_ACCOUNT/INTERRUPTED are internal codes, not sentences — the row must translate
  // them instead of showing the bare code to someone who does not read code
  it('내부 코드인 사유는 안내 문구로 바뀐다', () => {
    const html = render({ records: [rec({ status: 'failed', reason: 'NO_GENERATOR_ACCOUNT' })] })
    expect(html).toContain('hiw.record.reason.noAccount')
    expect(html).not.toContain('NO_GENERATOR_ACCOUNT')
  })

  it('앱이 꺼져 끊긴 기록도 코드가 아니라 안내 문구로 바뀐다', () => {
    const html = render({ records: [rec({ status: 'failed', reason: 'INTERRUPTED' })] })
    expect(html).toContain('hiw.record.reason.interrupted')
    expect(html).not.toContain('INTERRUPTED')
  })

  // CHECK_FAILED (Task 4): the model's write-up came back clean but a reported check did not —
  // this is exactly the gap INTERRUPTED shipped with once already (fixed later, as a review finding)
  it('검사가 실패한 기록도 코드가 아니라 안내 문구로 바뀐다', () => {
    const html = render({ records: [rec({ status: 'needs-review', reason: 'CHECK_FAILED' })] })
    expect(html).toContain('hiw.record.reason.checkFailed')
    expect(html).not.toContain('CHECK_FAILED')
  })

  // Item 8 (final review): a Job's failed validation is the app's own measurement, not the
  // agent's claim — it must translate to the Job-specific sentence, not the session one.
  it('Job 의 검사 실패는 세션과 다른 안내 문구로 바뀐다', () => {
    const html = render({
      records: [
        rec({
          status: 'needs-review',
          reason: 'CHECK_FAILED_JOB',
          source: { kind: 'job', runId: 'run1', jobName: '단축키 붙이기', taskIds: ['t1'] }
        })
      ]
    })
    expect(html).toContain('hiw.record.reason.checkFailedJob')
    expect(html).not.toContain('CHECK_FAILED_JOB')
  })

  // Every other reason is a free-form sentence the agent or the validator wrote, so it is shown
  // as it stands. Text we do not control gets no invented translation.
  it('알려지지 않은 사유는 고치지 않고 그대로 보인다', () => {
    const html = render({ records: [rec({ status: 'failed', reason: '알 수 없는 이유로 실패했다' })] })
    expect(html).toContain('알 수 없는 이유로 실패했다')
  })

  it('다 만든 줄에는 [다시] 가 없다', () => {
    expect(render({ records: [rec()] })).not.toContain('hiw.record.regenerate')
  })

  it('고른 줄에 on 이 붙는다', () => {
    expect(render({ records: [rec()] }, 'r1')).toContain('hiw-row on')
  })

  it('진행 중인 작업이 기록 목록 위에 선다', () => {
    const html = render({ records: [rec()] }, null, [task({ objective: '한도 감지 조사' })])
    const openIdx = html.indexOf('한도 감지 조사')
    const recordIdx = html.indexOf('한도 감지를 고쳐줘')
    expect(openIdx).toBeGreaterThanOrEqual(0)
    expect(recordIdx).toBeGreaterThan(openIdx)
  })

  it('중단된 작업은 사유와 함께 서고 완료 버튼을 단다', () => {
    const html = render({ records: [] }, null, [
      task({ status: 'interrupted', reason: 'INTERRUPTED_BY_NEW_TASK' })
    ])
    expect(html).toContain('hiw.open.reason.newTask')
    expect(html).toContain('hiw.open.complete')
    expect(html).toContain('hiw.open.cancel')
  })

  // Item 6 (final review): spec §11 draws 진행 중 and 마무리되지 않음 as two separate labelled
  // sections — a heading that just swaps text depending on whether anything is active would let an
  // interrupted-only row sit under "진행 중".
  it('진행 중과 마무리되지 않음은 각각 다른 절로 나뉘고, 진행 중이 먼저 온다', () => {
    const html = render({ records: [] }, null, [
      task({ id: 't1', status: 'active', objective: '진행 중인 작업' }),
      task({
        id: 't2',
        status: 'interrupted',
        objective: '중단된 작업',
        reason: 'INTERRUPTED_BY_NEW_TASK'
      })
    ])
    expect(html).toContain('hiw.open.title')
    expect(html).toContain('hiw.open.interruptedTitle')
    const inProgressLabel = html.indexOf('hiw.open.title')
    const unfinishedLabel = html.indexOf('hiw.open.interruptedTitle')
    const activeRow = html.indexOf('진행 중인 작업')
    const interruptedRow = html.indexOf('중단된 작업')
    expect(inProgressLabel).toBeLessThan(activeRow)
    expect(activeRow).toBeLessThan(unfinishedLabel) // the whole 진행 중 section comes before 마무리되지 않음
    expect(unfinishedLabel).toBeLessThan(interruptedRow)
  })

  it('마무리되지 않음 절의 각 줄에는 기록 줄처럼 날짜가 있다', () => {
    const html = render({ records: [] }, null, [
      task({
        status: 'interrupted',
        startedAt: '2026-08-29T01:00:00.000Z',
        endedAt: '2026-08-30T09:00:00.000Z',
        reason: 'INTERRUPTED_BY_SESSION_END'
      })
    ])
    expect(html).toContain('8/30') // endedAt's date — not startedAt's (8/29)
  })

  it('진행 중인 것이 없으면 그 절이 아예 없다', () => {
    const html = render({ records: [rec()] }, null, [])
    expect(html).not.toContain('hiw-open')
  })

  it('진행 중인 작업만 있고 기록이 없으면 빈 상태 대신 그 절을 보여준다', () => {
    const html = render({ records: [] }, null, [task()])
    expect(html).not.toContain('hiw.empty.body')
    expect(html).toContain('hiw-open')
  })

  // Same rule as a record's reason — the collector's INTERRUPTED_BY_* codes translate, anything
  // else (a code this screen has never heard of) is shown exactly as it arrived.
  it('모르는 중단 사유는 그대로 보인다', () => {
    const html = render({ records: [] }, null, [
      task({ status: 'interrupted', reason: '알 수 없는 이유로 멈췄다' })
    ])
    expect(html).toContain('알 수 없는 이유로 멈췄다')
  })
})
