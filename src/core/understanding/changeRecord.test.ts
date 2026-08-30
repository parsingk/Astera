import { describe, it, expect } from 'vitest'
import type { SessionWorkUnit } from '../workUnit/types'
import { changeSummaryOf, sessionLabelOf } from './changeRecord'

const unit = (over: Partial<SessionWorkUnit> = {}): SessionWorkUnit => ({
  id: 'wu-1',
  sessionId: '41b7384a-0050-4ce5-b638-52d80affbf6d',
  projectPath: 'D:\\p',
  title: '로그인 고쳐줘',
  status: 'completed',
  startedAt: '2026-08-30T10:00:00.000Z',
  completedAt: '2026-08-30T10:05:00.000Z',
  firstMessageIndex: 0,
  messageCount: 2,
  git: { startHead: 'a', endHead: 'b', observedChangedFiles: ['src/login.ts'] },
  encounteredExternalGitChangeIds: [],
  ...over
})

describe('changeSummaryOf — 완료된 Unit 하나가 최근 변경 한 줄이 된다', () => {
  it('body 는 사용자의 요청 원문이다 — 커밋 메시지가 아니다', () => {
    const c = changeSummaryOf(unit(), 'cs-1')!
    expect(c.body).toBe('로그인 고쳐줘')
    expect(c.id).toBe('cs-1')
    expect(c.sourceKind).toBe('session')
    expect(c.sourceId).toBe('41b7384a-0050-4ce5-b638-52d80affbf6d')
    expect(c.at).toBe('2026-08-30T10:05:00.000Z') // 닫힌 시각이지 시작 시각이 아니다
  })

  it('sourceLabel 은 스펙 표기("세션 …")에 id 앞 여덟 자다', () => {
    expect(sessionLabelOf('41b7384a-0050-4ce5-b638-52d80affbf6d')).toBe('세션 41b7384a')
    expect(changeSummaryOf(unit(), 'x')!.sourceLabel).toBe('세션 41b7384a')
  })

  // 스펙 §7 — 질문만 하다 버려진 Unit 은 하류로 흐르지 않는다
  it('completed 가 아니면 null 이다 — abandoned 도 active 도 변경이 아니다', () => {
    expect(changeSummaryOf(unit({ status: 'abandoned' }), 'x')).toBeNull()
    expect(changeSummaryOf(unit({ status: 'active' }), 'x')).toBeNull()
    expect(changeSummaryOf(unit({ status: 'completed-candidate' }), 'x')).toBeNull()
  })

  it('completedAt 이 없는 옛 레코드는 시작 시각으로 저하한다', () => {
    const c = changeSummaryOf(unit({ completedAt: undefined }), 'x')!
    expect(c.at).toBe('2026-08-30T10:00:00.000Z')
  })

  it('featureName 은 여기서 채우지 않는다 — 매핑의 일이다', () => {
    expect(changeSummaryOf(unit(), 'x')!.featureName).toBeUndefined()
  })
})
