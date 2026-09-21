import { describe, it, expect } from 'vitest'
import { installOutcomeNotice } from './manualInstallNotice'

describe('installOutcomeNotice — 설치 버튼을 누른 뒤 사람에게 할 말', () => {
  it('자동 경로에는 할 말이 없다 — 앱이 곧 스스로 꺼진다', () => {
    expect(installOutcomeNotice({ mode: 'auto' })).toBeNull()
  })

  it('수동 경로면 어디에 풀어 놨는지 말한다', () => {
    expect(installOutcomeNotice({ mode: 'manual', appPath: '/c/manual/1.3.25/Astera.app' })).toEqual({
      key: 'update.manual.done',
      params: { path: '/c/manual/1.3.25/Astera.app' }
    })
  })

  it('실패하면 이유를 말한다 — 침묵이 이 버그의 절반이었다', () => {
    expect(installOutcomeNotice({ mode: 'failed', message: 'ditto: 공간 부족' })).toEqual({
      key: 'update.manual.failed',
      params: { message: 'ditto: 공간 부족' }
    })
  })
})
