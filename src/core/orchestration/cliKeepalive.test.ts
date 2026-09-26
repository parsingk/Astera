import { describe, it, expect } from 'vitest'
import { HOST_UNRESPONSIVE_MS } from '../host/unresponsive'
import { KEEPALIVE_MS, elapsedWord, keepaliveLine, waitingCommand } from './cliKeepalive'

describe('cliKeepalive — 간격', () => {
  // 두 곳에 적으면 갈라진다. 이 CLI 와 앱이 같은 Host 를 두고 "언제부터 안 답하는 것인가" 를
  // 다르게 세면, 한쪽은 기다리는 중이라 하고 다른 쪽은 멈췄다고 한다.
  it('Host 가 조용해도 되는 시간과 같은 상수다', () => {
    expect(KEEPALIVE_MS).toBe(HOST_UNRESPONSIVE_MS)
  })
})

describe('cliKeepalive — 기다리는 명령만', () => {
  it('사람을 기다리는 넷이다', () => {
    expect(waitingCommand({ cmd: 'ask', args: {} })).toBe(true)
    expect(waitingCommand({ cmd: 'jobs-wait', args: { id: 'job_1' } })).toBe(true)
    expect(waitingCommand({ cmd: 'runs-wait', args: { id: 'run_1' } })).toBe(true)
    expect(waitingCommand({ cmd: 'check', args: { wait: true } })).toBe(true)
  })

  // `runs follow` can go quiet for as long as a wait does, between two events, and then a silent
  // stderr says nothing about whether the Host is still there. Its events go to stdout, never these.
  it('runs follow 도 기다리는 명령이다', () => {
    expect(waitingCommand({ cmd: 'runs-follow', args: { id: 'run_1' } })).toBe(true)
  })

  // 기다리지 않는 출력에 살아 있다는 줄이 붙으면, 그 줄은 아무것도 뜻하지 않게 된다.
  it('--wait 없는 check 는 기다리는 것이 아니다', () => {
    expect(waitingCommand({ cmd: 'check', args: {} })).toBe(false)
  })

  it('목록과 조회와 브라우저 스크립트는 기다리는 것이 아니다', () => {
    for (const cmd of ['jobs-list', 'jobs-get', 'status', 'browser-js', 'send', 'inbox'])
      expect(waitingCommand({ cmd, args: { wait: true } }), cmd).toBe(false)
  })
})

describe('cliKeepalive — 한 줄', () => {
  it('사람이 치는 모양으로 명령을 부르고 얼마나 기다렸는지 말한다', () => {
    expect(keepaliveLine({ cmd: 'runs-wait', elapsedMs: 15_000, silentMs: null })).toBe(
      'waiting for runs wait, 15s so far'
    )
  })

  // 이 줄이 있는 이유가 "이것이 멈춘 Host 인가" 이므로, 답할 수 있으면 답한다.
  it('ping 이 있는 Host 는 마지막으로 답한 때를 싣는다', () => {
    expect(keepaliveLine({ cmd: 'ask', elapsedMs: 30_000, silentMs: 200 })).toBe(
      'waiting for ask, 30s so far; the Host answered 0s ago'
    )
  })

  it('앱이 멈췄다고 판정하는 시간을 넘기면 안심시키지 않고 그 수를 말한다', () => {
    expect(keepaliveLine({ cmd: 'ask', elapsedMs: 45_000, silentMs: KEEPALIVE_MS })).toBe(
      'waiting for ask, 45s so far; the Host has not answered a ping for 15s'
    )
  })

  it('한 시간짜리 기다림도 읽을 수 있다', () => {
    expect(elapsedWord(3_600_000)).toBe('60m 0s')
    expect(elapsedWord(200_000)).toBe('3m 20s')
    expect(elapsedWord(0)).toBe('0s')
  })
})

describe('cliKeepalive — sessions send --wait waits', () => {
  it('only with --wait', () => {
    expect(waitingCommand({ cmd: 'sessions-send', args: { id: 's', text: 't', wait: true } })).toBe(true)
    expect(waitingCommand({ cmd: 'sessions-send', args: { id: 's', text: 't' } })).toBe(false)
  })
})
