import { describe, it, expect } from 'vitest'
import { createRendererGate, HELD_CHARS_CAP } from './rendererGate'

describe('createRendererGate', () => {
  // 이 버그 자체다. 앱이 켜지고 130ms 만에 Host 가 세션을 돌려주며 ring buffer 를 쏟아내는데,
  // 그 시점의 렌더러는 아직 번들을 실행하지도 않아 session:data 를 듣는 귀가 없다. 게이트가
  // 없으면 그 출력은 win.webContents.send 한 줄에서 그대로 증발하고, 사람은 탭만 남고 속은
  // 빈 — 검은 — 터미널을 본다.
  it('렌더러가 듣기 전에 온 출력을 붙잡아 두었다가 열릴 때 순서대로 흘린다', () => {
    const got: Array<[string, unknown]> = []
    const gate = createRendererGate((channel, payload) => got.push([channel, payload]))

    gate.send('session:data', { sessionId: 's1', data: 'first' })
    gate.send('session:data', { sessionId: 's1', data: 'second' })
    expect(got).toEqual([])

    gate.open()

    expect(got).toEqual([
      ['session:data', { sessionId: 's1', data: 'first' }],
      ['session:data', { sessionId: 's1', data: 'second' }]
    ])
  })

  // 게이트는 부팅 한 구간을 위한 것이지 상시 큐가 아니다. 열린 뒤에도 붙잡으면 살아 있는
  // 세션의 출력이 전부 한 박자씩 늦거나, open 이 다시 불리지 않는 한 영영 갇힌다.
  it('열린 뒤에 온 출력은 붙잡지 않고 곧바로 보낸다', () => {
    const got: Array<[string, unknown]> = []
    const gate = createRendererGate((channel, payload) => got.push([channel, payload]))

    gate.open()
    gate.send('session:data', { sessionId: 's1', data: 'live' })

    expect(got).toEqual([['session:data', { sessionId: 's1', data: 'live' }]])
  })

  // 붙잡는 것은 세션의 재생 데이터뿐이다. 탭도 목록도 세션도 App.tsx 가 sessions.list() 로 다시
  // 조회해 복원하지만, Host 의 ring buffer 는 attach 응답으로 단 한 번 오고 놓치면 그것으로
  // 끝이다. 나머지까지 함께 붙잡으면 이 좁은 수정이 부팅 이벤트 전체의 순서를 바꾸는 큰 수정이
  // 된다 — 조회로 이미 복원된 상태를 뒤늦게 덮어쓸 위험까지 딸려 온다.
  it('재생 데이터가 아닌 채널은 게이트와 무관하게 그대로 보낸다', () => {
    const got: Array<[string, unknown]> = []
    const gate = createRendererGate((channel, payload) => got.push([channel, payload]))

    gate.send('session:exit', { sessionId: 's1', exitCode: 0 })

    expect(got).toEqual([['session:exit', { sessionId: 's1', exitCode: 0 }]])
  })

  // 프로젝트 터미널은 붙잡을 이유가 없다. 메인의 TerminalManager 가 pty 출력을 live.buffer 에
  // 쌓아 두고, 렌더러는 terminal.list(projectPath) 로 그것을 받아 재생한다 — 이벤트를 놓쳐도
  // 되물을 곳이 있다. 되물을 곳이 없는 것은 세션뿐이고(rendererGate.ts 의 주석), 그래서 게이트도
  // 세션만 본다.
  it('터미널 출력은 붙잡지 않는다 — 메인 버퍼에서 되물을 수 있다', () => {
    const got: Array<[string, unknown]> = []
    const gate = createRendererGate((channel, payload) => got.push([channel, payload]))

    gate.send('terminal:data', { id: 't1', data: 'buffered' })

    expect(got).toEqual([['terminal:data', { id: 't1', data: 'buffered' }]])
  })

  // 렌더러가 끝내 오지 않는 경우 — 로드 실패, 크래시 — 붙잡은 것을 풀 사람이 없다. 그때도
  // 세션은 계속 출력하므로, 상한이 없으면 이 배열이 앱의 남은 수명 내내 자란다. 버리는 쪽은
  // 앞이다: 터미널이 되살릴 수 있는 것은 최근 화면이지 한참 전의 줄이 아니다(sessionBus 의
  // BUFFER_CAP 이 같은 이유로 같은 선택을 한다).
  it('상한을 넘으면 앞을 버리고 최근 출력을 남긴다', () => {
    const got: Array<[string, unknown]> = []
    const gate = createRendererGate((channel, payload) => got.push([channel, payload]))
    const chunk = 'x'.repeat(HELD_CHARS_CAP / 4)

    // 상한의 다섯 배를 밀어 넣는다 — 앞의 둘은 버려지고도 남아야 한다.
    for (let i = 0; i < 20; i += 1) {
      gate.send('session:data', { sessionId: 's1', data: i === 0 ? 'OLDEST' : chunk })
    }
    gate.send('session:data', { sessionId: 's1', data: 'NEWEST' })
    gate.open()

    const delivered = got.map(([, p]) => (p as { data: string }).data)
    expect(delivered.at(-1)).toBe('NEWEST')
    expect(delivered).not.toContain('OLDEST')
    expect(delivered.join('').length).toBeLessThanOrEqual(HELD_CHARS_CAP)
  })
})

// 안전장치(ipc.ts 의 타이머)와 렌더러의 신고가 겹쳐 들어올 수 있다. 두 번 열려도 같은 것을
// 두 번 보내면 터미널에 스크롤백이 두 벌 찍힌다.
describe('createRendererGate open 의 멱등성', () => {
  it('두 번 열어도 붙잡았던 것을 두 번 보내지 않는다', () => {
    const got: Array<[string, unknown]> = []
    const gate = createRendererGate((channel, payload) => got.push([channel, payload]))

    gate.send('session:data', { sessionId: 's1', data: 'once' })
    gate.open()
    gate.open()

    expect(got).toEqual([['session:data', { sessionId: 's1', data: 'once' }]])
  })
})

// 이 경로는 업데이트 뒤 재시작에서만 밟힌다 — 평소 실행에서는 붙잡을 것 자체가 없다. 그래서
// 다음에 같은 일이 벌어졌을 때 "게이트가 실제로 일했는가" 를 사람이 확인할 수 있어야 하고,
// open 이 무엇을 풀었는지 돌려주는 것이 그 확인의 근거가 된다(ipc.ts 가 이것을 로그로 남긴다).
describe('createRendererGate open 의 보고', () => {
  it('풀어 준 조각 수와 글자 수를 돌려준다', () => {
    const gate = createRendererGate(() => {})

    gate.send('session:data', { sessionId: 's1', data: '12345' })
    gate.send('session:data', { sessionId: 's2', data: '123' })

    expect(gate.open()).toEqual({ count: 2, chars: 8 })
  })

  // 붙잡은 것이 없으면 로그도 남길 이유가 없다 — 평소 실행이 이쪽이다.
  it('붙잡은 것이 없으면 0 을 돌려준다', () => {
    const gate = createRendererGate(() => {})
    expect(gate.open()).toEqual({ count: 0, chars: 0 })
  })
})
