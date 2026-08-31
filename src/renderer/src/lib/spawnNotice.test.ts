import { describe, it, expect } from 'vitest'
import { spawnNotice } from './spawnNotice'

describe('spawnNotice — 세션 생성 뒤 사용자에게 알릴 것', () => {
  it('평범한 새 세션은 알릴 것이 없다', () => {
    expect(
      spawnNotice({
        requestedResumeSessionId: undefined,
        returnedResumeSessionId: undefined,
        returnedTabAlreadyOpen: false
      })
    ).toBeNull()
  })

  it('대화를 그대로 이어받은 재개도 알릴 것이 없다', () => {
    expect(
      spawnNotice({
        requestedResumeSessionId: 'conv-1',
        returnedResumeSessionId: 'conv-1',
        returnedTabAlreadyOpen: false
      })
    ).toBeNull()
  })

  // 롤링 가드: 이미 살아 있는 체인의 대화를 히스토리에서 열면 main 이 새로 띄우지 않고 그 탭을
  // 그대로 돌려준다. 그러면 모달에서 고른 계정·옵션이 조용히 버려지므로 그 사실을 알려야 한다.
  it('이미 열려 있는 탭이 돌아오면 옵션이 버려졌다고 알린다', () => {
    expect(
      spawnNotice({
        requestedResumeSessionId: 'conv-1',
        returnedResumeSessionId: 'conv-1',
        returnedTabAlreadyOpen: true
      })
    ).toBe('resumeLiveIgnored')
  })

  // Smart Resume 의 백지 재개. 재개를 **요청했는데** 돌아온 세션이 아무것도 재개하지 않았다는 것이
  // 그 신호다 — spawnSession(main/ipc.ts)이 백지로 갈 때 resumeSessionId 를 undefined 로 덮기
  // 때문이다. 사용자에게는 "이어하기를 눌렀는데 빈 창이 떴다"로 보이므로 반드시 알려야 한다.
  it('재개를 요청했는데 아무것도 재개하지 않고 돌아오면 백지 재개라고 알린다', () => {
    expect(
      spawnNotice({
        requestedResumeSessionId: 'conv-1',
        returnedResumeSessionId: undefined,
        returnedTabAlreadyOpen: false
      })
    ).toBe('smartResume')
  })

  // 두 신호가 겹칠 수 있는 조합에서 가드가 이긴다: 돌려받은 것이 **다른 세션의 탭**이라면 이번
  // 재개는 일어나지도 않았으므로, 백지 재개를 알리는 것은 거짓말이 된다.
  it('가드가 걸린 탭이 재개 세션을 안 들고 있어도 백지 재개로 보지 않는다', () => {
    expect(
      spawnNotice({
        requestedResumeSessionId: 'conv-1',
        returnedResumeSessionId: undefined,
        returnedTabAlreadyOpen: true
      })
    ).toBe('resumeLiveIgnored')
  })
})
