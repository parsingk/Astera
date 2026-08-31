import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProjectUnderstanding, WorkRecord } from '../../../core/understanding/types'
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

const render = (u: ProjectUnderstanding | null, selectedRecordId: string | null = null): string =>
  renderToStaticMarkup(
    React.createElement(UnderstandingView, {
      understanding: u,
      selectedRecordId,
      onOpenRecord: () => {},
      onRegenerate: () => {}
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
})
