import { describe, it, expect, vi } from 'vitest'
import {
  SlackInbox,
  SlackInboxController,
  inboxTargetFor,
  type SlackInboxDeps,
  type SlackInboxControllerDeps,
  type SocketClient
} from './slackInbox'
import { MAX_INJECT_CHARS } from '../core/slack/inbound'

const CH = 'C-target'
const ME = 'U-owner' // 허용된 Member ID — Slack은 메시지 이벤트의 user 필드로 보낸다

/** 가짜 SocketModeClient — 등록된 리스너를 직접 호출해 이벤트를 흘린다 (실제 연결 없음) */
function fakeClient(): {
  client: SocketClient
  emit: (event: string, arg: unknown) => void
  started: () => boolean
} {
  const listeners = new Map<string, (arg: never) => void>()
  let started = false
  const client: SocketClient = {
    on: (event, listener) => listeners.set(event, listener),
    start: async () => {
      started = true
      return {}
    },
    disconnect: async () => {}
  }
  return {
    client,
    emit: (event, arg) => listeners.get(event)?.(arg as never),
    started: () => started
  }
}

function setup(over: Partial<SlackInboxDeps> = {}): {
  inbox: SlackInbox
  writes: { sessionId: string; data: string }[]
  notes: { threadTs: string; text: string }[]
  logs: string[]
  deps: SlackInboxDeps
} {
  const writes: { sessionId: string; data: string }[] = []
  const notes: { threadTs: string; text: string }[] = []
  const logs: string[] = []
  const deps: SlackInboxDeps = {
    channelId: CH,
    memberId: () => ME,
    // 스레드 안내 문장은 i18n을 타므로 언어를 고정한다 — 아래 단정들이 ko 문구를 그대로 쓴다.
    lang: () => 'ko',
    resolveSession: (ts) => (ts === 'T-live' ? 's-1' : null),
    write: (sessionId, data) => {
      writes.push({ sessionId, data })
      return true
    },
    postNote: async (threadTs, text) => {
      notes.push({ threadTs, text })
    },
    isOwnMessage: () => false,
    log: (m) => logs.push(m),
    ...over
  }
  return { inbox: new SlackInbox(deps), writes, notes, logs, deps }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const message = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  channel: CH,
  text: '계속 진행해',
  thread_ts: 'T-live',
  ts: '1700000500.000200',
  user: ME,
  ...over
})

describe('SlackInbox 주입', () => {
  it('스레드 답장을 해당 세션 PTY에 넣는다 — 텍스트를 먼저 쓰고 Enter는 지연 후 별도로 보낸다', async () => {
    vi.useFakeTimers()
    try {
      const h = setup()
      const f = fakeClient()
      await h.inbox.start(f.client)

      let acked = false
      f.emit('message', { ack: async () => void (acked = true), event: message() })
      await vi.advanceTimersByTimeAsync(0)

      expect(acked).toBe(true) // ack 없으면 Slack이 재전송한다
      expect(h.writes).toEqual([{ sessionId: 's-1', data: '계속 진행해' }]) // Enter는 아직
      expect(h.notes).toEqual([])

      await vi.advanceTimersByTimeAsync(150) // ENTER_DELAY_MS

      expect(h.writes).toEqual([
        { sessionId: 's-1', data: '계속 진행해' },
        { sessionId: 's-1', data: '\r' }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('여러 줄 답장은 Alt+Enter로 개행하고, 지연 후 Enter로 제출한다', async () => {
    vi.useFakeTimers()
    try {
      const h = setup()
      const f = fakeClient()
      await h.inbox.start(f.client)

      f.emit('message', { ack: async () => {}, event: message({ text: '첫 줄\n두 번째' }) })
      await vi.advanceTimersByTimeAsync(150)

      expect(h.writes).toEqual([
        { sessionId: 's-1', data: '첫 줄\x1b\r두 번째' },
        { sessionId: 's-1', data: '\r' }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('Enter 지연 중 세션이 죽어 write가 실패해도 텍스트는 이미 들어갔으므로 추가 안내는 남기지 않는다', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const writesLog: { sessionId: string; data: string }[] = []
      const h = setup({
        write: (sessionId, data) => {
          calls++
          writesLog.push({ sessionId, data })
          return calls === 1 // 첫 호출(텍스트)만 성공, Enter 시도 때는 세션이 죽어 실패
        }
      })
      const f = fakeClient()
      await h.inbox.start(f.client)

      f.emit('message', { ack: async () => {}, event: message() })
      await vi.advanceTimersByTimeAsync(150)

      expect(calls).toBe(2) // 텍스트 시도 + Enter 시도(둘 다 호출은 됐다)
      expect(writesLog).toEqual([
        { sessionId: 's-1', data: '계속 진행해' },
        { sessionId: 's-1', data: '\r' }
      ])
      expect(h.notes).toEqual([]) // 텍스트 주입 자체는 성공했으므로 추가 안내는 없다
    } finally {
      vi.useRealTimers()
    }
  })

  it('봇 자신의 메시지는 주입하지 않는다 — 무한 루프 차단', async () => {
    const h = setup()
    const f = fakeClient()
    await h.inbox.start(f.client)

    f.emit('message', { ack: async () => {}, event: message({ bot_id: 'B1' }) })
    await flush()

    expect(h.writes).toEqual([])
    // 봇 메시지는 매 알림마다 돌아오므로 로그도 남기지 않는다
    expect(h.logs.some((l) => l.includes('ignored'))).toBe(false)
  })

  it('우리가 게시한 ts로 오는 이벤트는 무시한다 — bot_id가 빠지는 경로에 대한 2차 방어', async () => {
    const h = setup({ isOwnMessage: (ts) => ts === 'OUR-TS' })
    const f = fakeClient()
    await h.inbox.start(f.client)

    f.emit('message', { ack: async () => {}, event: message({ ts: 'OUR-TS', bot_id: undefined }) })
    await flush()

    expect(h.writes).toEqual([])
  })

  it('ack 실패로 인한 재전송은 두 번째부터 무시한다 — 이중 주입 방지', async () => {
    const h = setup()
    const f = fakeClient()
    await h.inbox.start(f.client)

    const ev = message({ ts: 'DUP-1' })
    f.emit('message', {
      ack: async () => {
        throw new Error('ack failed')
      },
      event: ev
    })
    await flush()
    f.emit('message', { ack: async () => {}, event: ev }) // Slack이 같은 envelope을 재전송
    await flush()

    expect(h.writes.filter((w) => w.data === '계속 진행해')).toHaveLength(1)
  })

  it('설정된 채널이 아닌 이벤트는 주입하지 않는다', async () => {
    const h = setup()
    const f = fakeClient()
    await h.inbox.start(f.client)

    f.emit('message', { ack: async () => {}, event: message({ channel: 'C-other' }) })
    await flush()

    expect(h.writes).toEqual([])
    expect(h.logs.some((l) => l.includes('other-channel'))).toBe(true)
  })

  it('스레드 답장이 아닌 채널 메시지는 주입하지 않는다', async () => {
    const h = setup()
    const f = fakeClient()
    await h.inbox.start(f.client)

    f.emit('message', { ack: async () => {}, event: message({ thread_ts: undefined }) })
    await flush()

    expect(h.writes).toEqual([])
    expect(h.logs.some((l) => l.includes('not-thread-reply'))).toBe(true)
  })

  it('너무 긴 답장은 주입하지 않고 스레드에 안내한다', async () => {
    const h = setup()
    const f = fakeClient()
    await h.inbox.start(f.client)

    f.emit('message', { ack: async () => {}, event: message({ text: 'x'.repeat(MAX_INJECT_CHARS + 1) }) })
    await flush()

    expect(h.writes).toEqual([])
    expect(h.notes).toHaveLength(1)
    expect(h.notes[0].threadTs).toBe('T-live')
    expect(h.notes[0].text).toContain('너무 길어')
  })

  it('매핑 없는 스레드(종료된 세션)에는 안내 답글을 남긴다', async () => {
    const h = setup()
    const f = fakeClient()
    await h.inbox.start(f.client)

    f.emit('message', { ack: async () => {}, event: message({ thread_ts: 'T-dead' }) })
    await flush()

    expect(h.writes).toEqual([])
    expect(h.notes).toHaveLength(1)
    expect(h.notes[0].threadTs).toBe('T-dead')
    expect(h.notes[0].text).toContain('종료')
  })

  it('스레드는 매핑돼 있지만 write가 false(세션 종료)를 돌려주면 안내 답글을 남긴다', async () => {
    const h = setup({ write: () => false })
    const f = fakeClient()
    await h.inbox.start(f.client)

    f.emit('message', { ack: async () => {}, event: message() })
    await flush()

    expect(h.notes).toHaveLength(1)
    expect(h.notes[0].text).toContain('종료')
    expect(h.logs.some((l) => l.includes('session exited'))).toBe(true)
  })

  it('주입이 던지면 로그를 남기고 스레드에 알린다 — 폰에서는 터미널을 볼 수 없다', async () => {
    const h = setup({
      write: () => {
        throw new Error('write failed')
      }
    })
    const f = fakeClient()
    await h.inbox.start(f.client)

    f.emit('message', { ack: async () => {}, event: message() })
    await flush()

    expect(h.notes).toHaveLength(1)
    expect(h.logs.some((l) => l.includes('injection failed'))).toBe(true)
  })

  it('ack가 실패해도 주입은 계속한다', async () => {
    const h = setup()
    const f = fakeClient()
    await h.inbox.start(f.client)

    f.emit('message', {
      ack: async () => {
        throw new Error('ack failed')
      },
      event: message()
    })
    await flush()

    expect(h.writes).toHaveLength(1)
  })

  it('event가 없는 페이로드도 던지지 않는다', async () => {
    const h = setup()
    const f = fakeClient()
    await h.inbox.start(f.client)

    f.emit('message', { ack: async () => {} })
    await flush()

    expect(h.writes).toEqual([])
  })
})

describe('SlackInbox — Member ID 제한', () => {
  it('허용된 Member ID가 아닌 사람의 답장은 주입하지 않고 스레드에도 남기지 않는다', async () => {
    const h = setup()
    const f = fakeClient()
    await h.inbox.start(f.client)

    f.emit('message', { ack: async () => {}, event: message({ user: 'U-stranger' }) })
    await flush()

    expect(h.writes).toEqual([])
    expect(h.notes).toEqual([]) // 외부인에게 봇이 반응하면 안 된다
    // 거절된 id를 함께 남긴다 — 본인 ID 오타를 이 값으로 바로 고칠 수 있다
    expect(h.logs.some((l) => l.includes('not-allowed-user') && l.includes('U-stranger'))).toBe(true)
  })

  it('Member ID가 설정돼 있지 않으면 주입하지 않는다 — 로그가 미설정임을 밝힌다', async () => {
    const h = setup({ memberId: () => null })
    const f = fakeClient()
    await h.inbox.start(f.client)

    f.emit('message', { ack: async () => {}, event: message() })
    await flush()

    expect(h.writes).toEqual([])
    expect(h.notes).toEqual([])
    expect(h.logs.some((l) => l.includes('member-id-unset'))).toBe(true)
  })

  it('허용되지 않은 사람의 너무 긴 답장에도 스레드 안내를 남기지 않는다', async () => {
    const h = setup()
    const f = fakeClient()
    await h.inbox.start(f.client)

    f.emit('message', {
      ack: async () => {},
      event: message({ user: 'U-stranger', text: 'x'.repeat(MAX_INJECT_CHARS + 1) })
    })
    await flush()

    expect(h.writes).toEqual([])
    expect(h.notes).toEqual([])
  })

  it('memberId는 매 이벤트마다 다시 읽는다 — 설정 변경이 재연결 없이 반영돼야 한다', async () => {
    let allowed: string | null = 'U-old'
    const h = setup({ memberId: () => allowed })
    const f = fakeClient()
    await h.inbox.start(f.client)

    f.emit('message', { ack: async () => {}, event: message({ ts: 'TS-1' }) })
    await flush()
    expect(h.writes).toEqual([]) // ME는 아직 허용 대상이 아니다

    allowed = ME // 설정 화면에서 저장한 상황 — 소켓은 그대로다
    f.emit('message', { ack: async () => {}, event: message({ ts: 'TS-2' }) })
    await flush()

    expect(h.writes).toEqual([{ sessionId: 's-1', data: '계속 진행해' }])
  })
})

describe('SlackInbox 연결', () => {
  it('start가 클라이언트를 시작한다', async () => {
    const h = setup()
    const f = fakeClient()

    await h.inbox.start(f.client)

    expect(f.started()).toBe(true)
  })

  it('연결 실패는 로그만 남기고 던지지 않는다 — 알림 전송은 계속돼야 한다', async () => {
    const h = setup()
    const client: SocketClient = {
      on: () => {},
      start: async () => {
        throw new TypeError('invalid_auth xapp-secret')
      },
      disconnect: async () => {}
    }

    await h.inbox.start(client) // 던지지 않는다

    expect(h.logs.some((l) => l.includes('start failed'))).toBe(true)
    // 앱 토큰이 섞인 message는 남기지 않는다 — 이름만
    expect(h.logs.some((l) => l.includes('xapp-'))).toBe(false)
  })

  it('연결 실패 로그는 botErrorReason(name:code:data.error)을 쓴다 — err.name만이 아니다', async () => {
    const h = setup()
    class PlatformError extends Error {
      code = 'slack_webapi_platform_error'
      data = { error: 'invalid_auth' }
      constructor() {
        super('An API error occurred: invalid_auth')
        this.name = 'WebAPIPlatformError'
      }
    }
    const client: SocketClient = {
      on: () => {},
      start: async () => {
        throw new PlatformError()
      },
      disconnect: async () => {}
    }

    await h.inbox.start(client)

    expect(h.logs.some((l) => l.includes('WebAPIPlatformError:slack_webapi_platform_error:invalid_auth'))).toBe(
      true
    )
  })

  it('stop은 클라이언트를 끊고, 두 번 불러도 안전하다', async () => {
    const h = setup()
    let disconnects = 0
    const client: SocketClient = {
      on: () => {},
      start: async () => ({}),
      disconnect: async () => void disconnects++
    }
    await h.inbox.start(client)

    await h.inbox.stop()
    await h.inbox.stop()

    expect(disconnects).toBe(1)
  })
})

describe('inboxTargetFor', () => {
  it('appToken·botToken·channelId가 모두 있어야 대상이 된다', () => {
    expect(inboxTargetFor({ appToken: 'xapp', botToken: 'xoxb', channelId: 'C1' })).toEqual({
      channelId: 'C1',
      appToken: 'xapp'
    })
    expect(inboxTargetFor({ appToken: null, botToken: 'xoxb', channelId: 'C1' })).toBeNull()
    expect(inboxTargetFor({ appToken: 'xapp', botToken: null, channelId: 'C1' })).toBeNull()
    expect(inboxTargetFor({ appToken: 'xapp', botToken: 'xoxb', channelId: null })).toBeNull()
  })
})

describe('SlackInboxController — 설정 변경 시 재구성', () => {
  interface FakeSocket {
    channelId: string
    appToken: string
    starts: number
    disconnects: number
  }

  function setupController(): {
    controller: SlackInboxController
    sockets: FakeSocket[]
    quitting: { value: boolean }
    /** 마지막으로 소켓에 넘어간 memberId getter — 재연결 없이 갱신되는지 확인하는 데 쓴다 */
    memberIdOf: () => string | null
  } {
    const sockets: FakeSocket[] = []
    const quitting = { value: false }
    let lastChannelId = ''
    let lastMemberId: () => string | null = () => null
    const deps: SlackInboxControllerDeps = {
      makeDeps: (channelId, memberId) => {
        lastChannelId = channelId
        lastMemberId = memberId
        return {
          channelId,
          memberId,
          lang: () => 'ko' as const,
          resolveSession: () => null,
          write: () => true,
          postNote: async () => {},
          isOwnMessage: () => false,
          log: () => {}
        }
      },
      createClient: (appToken) => {
        const entry: FakeSocket = { channelId: lastChannelId, appToken, starts: 0, disconnects: 0 }
        sockets.push(entry)
        const client: SocketClient = {
          on: () => {},
          start: async () => {
            entry.starts++
            return {}
          },
          disconnect: async () => void entry.disconnects++
        }
        return client
      },
      isQuitting: () => quitting.value
    }
    return {
      controller: new SlackInboxController(deps),
      sockets,
      quitting,
      memberIdOf: () => lastMemberId()
    }
  }

  it('토큰·채널·앱토큰 중 하나라도 없으면 연결하지 않는다', async () => {
    const h = setupController()
    await h.controller.apply({ appToken: null, botToken: 'xoxb', channelId: 'C1', memberId: ME })
    expect(h.sockets).toHaveLength(0)
  })

  it('셋 다 있으면 연결한다', async () => {
    const h = setupController()
    await h.controller.apply({ appToken: 'xapp-1', botToken: 'xoxb-1', channelId: 'C1', memberId: ME })
    expect(h.sockets).toHaveLength(1)
    expect(h.sockets[0]).toMatchObject({ channelId: 'C1', appToken: 'xapp-1', starts: 1 })
  })

  it('봇 모드를 끄면(필드 제거) 기존 소켓을 끊고 새로 열지 않는다', async () => {
    const h = setupController()
    await h.controller.apply({ appToken: 'xapp-1', botToken: 'xoxb-1', channelId: 'C1', memberId: ME })
    await h.controller.apply({ appToken: null, botToken: null, channelId: null, memberId: null })

    expect(h.sockets).toHaveLength(1)
    expect(h.sockets[0].disconnects).toBe(1)
  })

  it('채널이 바뀌면 옛 소켓을 끊고 새 채널로 다시 연다', async () => {
    const h = setupController()
    await h.controller.apply({ appToken: 'xapp-1', botToken: 'xoxb-1', channelId: 'C1', memberId: ME })
    await h.controller.apply({ appToken: 'xapp-1', botToken: 'xoxb-1', channelId: 'C2', memberId: ME })

    expect(h.sockets).toHaveLength(2)
    expect(h.sockets[0].disconnects).toBe(1)
    expect(h.sockets[1]).toMatchObject({ channelId: 'C2', starts: 1 })
  })

  it('같은 설정을 다시 적용해도 재연결하지 않는다', async () => {
    const h = setupController()
    const cfg = { appToken: 'xapp-1', botToken: 'xoxb-1', channelId: 'C1', memberId: ME }
    await h.controller.apply(cfg)
    await h.controller.apply({ ...cfg })

    expect(h.sockets).toHaveLength(1)
    expect(h.sockets[0].disconnects).toBe(0)
  })

  it('종료 중이면 새 소켓을 열지 않는다 — config load가 종료 이후 resolve되는 레이스', async () => {
    const h = setupController()
    h.quitting.value = true
    await h.controller.apply({ appToken: 'xapp-1', botToken: 'xoxb-1', channelId: 'C1', memberId: ME })

    expect(h.sockets).toHaveLength(0)
  })

  it('stop()은 열려 있는 소켓을 끊는다', async () => {
    const h = setupController()
    await h.controller.apply({ appToken: 'xapp-1', botToken: 'xoxb-1', channelId: 'C1', memberId: ME })
    await h.controller.stop()

    expect(h.sockets[0].disconnects).toBe(1)
  })

  it('memberId만 바뀌면 재연결하지 않는다 — 소켓과 무관한 값이다', async () => {
    const h = setupController()
    await h.controller.apply({
      appToken: 'xapp-1',
      botToken: 'xoxb-1',
      channelId: 'C1',
      memberId: 'U-old'
    })
    await h.controller.apply({
      appToken: 'xapp-1',
      botToken: 'xoxb-1',
      channelId: 'C1',
      memberId: 'U-new'
    })

    expect(h.sockets).toHaveLength(1)
    expect(h.sockets[0].disconnects).toBe(0)
  })

  it('재연결하지 않아도 새 memberId가 살아있는 소켓에 반영된다 — 값이 아니라 getter로 넘기는 이유', async () => {
    // 값으로 넘기면 재연결 키(appToken+channelId)가 그대로이므로 이 변경은 영원히 반영되지 않는다.
    const h = setupController()
    await h.controller.apply({
      appToken: 'xapp-1',
      botToken: 'xoxb-1',
      channelId: 'C1',
      memberId: 'U-old'
    })
    expect(h.memberIdOf()).toBe('U-old')

    await h.controller.apply({
      appToken: 'xapp-1',
      botToken: 'xoxb-1',
      channelId: 'C1',
      memberId: 'U-new'
    })

    expect(h.sockets).toHaveLength(1) // 재연결은 없었다
    expect(h.memberIdOf()).toBe('U-new') // 그런데도 새 값이 보인다
  })

  it('봇 모드를 끄면 memberId getter도 null로 수렴한다', async () => {
    const h = setupController()
    await h.controller.apply({
      appToken: 'xapp-1',
      botToken: 'xoxb-1',
      channelId: 'C1',
      memberId: 'U-old'
    })
    await h.controller.apply({ appToken: null, botToken: null, channelId: null, memberId: null })

    expect(h.memberIdOf()).toBeNull()
  })

  it('apply 호출이 겹쳐도(레이스) 순서대로 직렬 처리된다', async () => {
    const h = setupController()
    const p1 = h.controller.apply({ appToken: 'xapp-1', botToken: 'xoxb-1', channelId: 'C1', memberId: ME })
    const p2 = h.controller.apply({ appToken: 'xapp-1', botToken: 'xoxb-1', channelId: 'C2', memberId: ME })
    await Promise.all([p1, p2])

    expect(h.sockets).toHaveLength(2)
    expect(h.sockets[0].disconnects).toBe(1) // C1 소켓은 끊겼다
    expect(h.sockets[1].disconnects).toBe(0) // 최종적으로 C2 소켓만 살아있다
  })
})
