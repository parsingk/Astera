import { describe, it, expect, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Account, SessionInfo } from '../core/types'
import { SlackNotifier, SlackConfigStore, type SlackConfig, type SlackDeps } from './slack'
import { SlackPostError, type SlackTransport } from './slackTransport'
import { isSlackReady } from '../core/slack/ready'

/** 설정 한 벌을 만든다 — 지정하지 않은 필드는 null. SlackConfig에 필드가 늘 때마다 아래 테스트들의
 *  save()/toEqual()을 전부 손대야 하는 것을 막는다(실제로 겪었다).
 *  toEqual은 여전히 완전 비교다 — 헬퍼가 모든 필드를 채우기 때문이다. */
const cfg = (over: Partial<SlackConfig> = {}): SlackConfig => ({
  webhookUrl: null,
  botToken: null,
  channelId: null,
  appToken: null,
  memberId: null,
  ...over
})

const account: Account = {
  id: 'acc-1', label: 'work1', configDir: 'D:\\cfg', color: '#fff', createdAt: '2026-07-23T00:00:00Z'
}
const codexAccount: Account = { ...account, id: 'acc-codex', label: 'codex1', provider: 'codex' }
const info = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  id: 's-1', accountId: 'acc-1', cwd: 'D:\\proj\\myproj', status: 'running', title: 'myproj',
  slackNotify: true, ...over
})
const codexSession = (id: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  info({ id, accountId: codexAccount.id, ...over })
const assistantLine = (text: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

function setup(over: Partial<SlackDeps> = {}): {
  notifier: SlackNotifier
  sent: string[]
  logs: string[]
  advance: (ms: number) => void
} {
  const sent: string[] = []
  const logs: string[] = []
  let nowMs = 1_000_000
  const deps: SlackDeps = {
    getAccount: (id) => (id === codexAccount.id ? codexAccount : account),
    readStatusPayload: async () => null,
    // 알림 문장은 i18n을 타므로 언어를 고정한다 — 아래 단정들이 ko 문구를 그대로 쓴다.
    lang: () => 'ko',
    log: (m) => logs.push(m),
    readFileTail: async () => null,
    fetchFn: (async (_url: unknown, init?: RequestInit) => {
      sent.push((JSON.parse(String(init?.body)) as { text: string }).text)
      return { ok: true, status: 200 } as Response
    }) as unknown as typeof fetch,
    now: () => nowMs,
    ...over
  }
  const notifier = new SlackNotifier(deps)
  notifier.setWebhookUrl('https://hooks.slack.com/services/T/B/x')
  return { notifier, sent, logs, advance: (ms) => (nowMs += ms) }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('SlackNotifier 훅 이벤트', () => {
  it('Notification 훅 → 프리픽스 붙은 입력 필요 알림', async () => {
    const h = setup()
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', { hook_event_name: 'Notification', message: '권한 승인이 필요합니다' })
    await flush()
    expect(h.sent).toEqual(['[myproj · work1] 🙋 입력 필요 — 권한 승인이 필요합니다'])
  })

  it('Notification 유휴 문구는 입력 필요로 알리지 않는다 (턴 종료 60초 후 자동 발화)', async () => {
    const h = setup()
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', {
      hook_event_name: 'Notification',
      message: 'Claude is waiting for your input'
    })
    await flush()
    expect(h.sent).toEqual([])
  })

  // notification_type 기반 판정이 이 진입점까지 실제로 닿는지 고정한다.
  // 이쪽 극성은 rolling과 반대다 — 유휴로 판정하면 '전송을 억제'하므로, 오판은 사용자가 막힌
  // 세션을 영영 모르게 되는 쪽으로 작동한다.
  it('타입이 유휴면 문구가 무엇이든 억제한다', async () => {
    const h = setup()
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', {
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: '문구는 바뀌었지만 타입은 유휴다'
    })
    await flush()
    expect(h.sent).toEqual([])
  })

  it('타입이 유휴가 아니면 문구가 유휴여도 알린다 — 타입이 우선', async () => {
    const h = setup()
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', {
      hook_event_name: 'Notification',
      notification_type: 'worker_permission_prompt',
      message: 'Claude is waiting for your input'
    })
    await flush()
    expect(h.sent).toEqual(['[myproj · work1] 🙋 입력 필요 — Claude is waiting for your input'])
  })

  it('Stop 훅 → transcript 꼬리의 마지막 assistant 텍스트를 발췌해 전송', async () => {
    const h = setup({ readFileTail: async () => assistantLine('마지막 응답 요약') })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', { hook_event_name: 'Stop', transcript_path: 'D:\\t.jsonl' })
    await flush()
    expect(h.sent[0]).toContain('✅ 응답 완료')
    expect(h.sent[0]).toContain('> 마지막 응답 요약')
  })

  // 실측: 텍스트가 있는 1,159턴 중 49.7%가 세그먼트 2개 이상이고, 마지막 조각만 보내면 턴 전체
  // 텍스트의 77.8%만 전달됐다(자세한 수치는 extractLastTurnAssistantText 주석). 핵심 결론이 앞
  // 세그먼트에 있으면 Slack에는 맺음말만 가던 경로를 이 진입점에서 고정한다.
  it('Stop 훅 → 도구 호출로 쪼개진 앞 세그먼트도 함께 보낸다', async () => {
    const tail = [
      JSON.stringify({ type: 'user', message: { content: '작업 지시' } }),
      assistantLine('커밋이 hook에 막혔습니다'),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }
      }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }),
      assistantLine('무엇을 확인할까요?')
    ].join('\n')
    const h = setup({ readFileTail: async () => tail })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', { hook_event_name: 'Stop', transcript_path: 'D:\\t.jsonl' })
    await flush()
    expect(h.sent[0]).toContain('> 커밋이 hook에 막혔습니다')
    expect(h.sent[0]).toContain('> 무엇을 확인할까요?')
  })

  it('Stop 훅: transcript 읽기 실패여도 완료 사실은 알린다', async () => {
    const h = setup({ readFileTail: async () => null })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', { hook_event_name: 'Stop', transcript_path: 'D:\\t.jsonl' })
    await flush()
    expect(h.sent).toEqual(['[myproj · work1] ✅ 응답 완료'])
  })

  // 실사용에서 첫 턴 알림이 발췌 없이 `✅ 응답 완료` 만으로 온 일이 있다. 그 시점 트랜스크립트를
  // 잘라가며 추출기를 돌려 보니 마지막 assistant 텍스트 줄이 파일에 없을 때만 null 이 됐고, 같은
  // Stop payload 에는 그 텍스트가 last_assistant_message 로 실려 있었다. 읽기가 OS 오류로 실패한
  // 것인지 그 줄이 아직 flush 되지 않은 것인지는 남은 기록으로 가릴 수 없다 — 어느 쪽이든 결과가
  // 맞도록 payload 를 폴백으로 쓴다.
  it('Stop 훅: 꼬리에서 못 찾으면 payload 의 last_assistant_message 로 채운다', async () => {
    const h = setup({ readFileTail: async () => null })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', {
      hook_event_name: 'Stop',
      transcript_path: 'D:\\t.jsonl',
      last_assistant_message: '서브에이전트를 띄웠습니다.'
    })
    await flush()
    expect(h.sent).toEqual(['[myproj · work1] ✅ 응답 완료\n> 서브에이전트를 띄웠습니다.'])
  })

  it('Stop 훅: 꼬리에 텍스트가 있으면 payload 보다 꼬리가 이긴다 — 턴 전체가 담기는 쪽이다', async () => {
    const tail = [
      JSON.stringify({ type: 'user', message: { content: '지시' } }),
      assistantLine('앞 세그먼트'),
      assistantLine('뒤 세그먼트')
    ].join('\n')
    const h = setup({ readFileTail: async () => tail })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', {
      hook_event_name: 'Stop',
      transcript_path: 'D:\\t.jsonl',
      last_assistant_message: '뒤 세그먼트'
    })
    await flush()
    expect(h.sent[0]).toBe('[myproj · work1] ✅ 응답 완료\n> 앞 세그먼트\n> \n> 뒤 세그먼트')
  })

  it('Stop 훅: 발췌가 비면 이유를 로그로 남긴다 — 읽기 실패와 텍스트 없음을 구분한다', async () => {
    const failed = setup({ readFileTail: async () => null })
    failed.notifier.register(info())
    failed.notifier.onHookEvent('s-1', { hook_event_name: 'Stop', transcript_path: 'D:\\t.jsonl' })
    await flush()
    expect(failed.logs.some((l) => l.includes('transcript read failed'))).toBe(true)

    const empty = setup({ readFileTail: async () => '{"type":"user","message":{"content":"지시"}}' })
    empty.notifier.register(info())
    empty.notifier.onHookEvent('s-1', { hook_event_name: 'Stop', transcript_path: 'D:\\t.jsonl' })
    await flush()
    expect(empty.logs.some((l) => l.includes('no assistant text'))).toBe(true)
  })

  // 종전에는 EXCERPT_MAX(500)에서 잘랐다. 사용자가 잘린 내용을 다 보고 싶다고 해서 Slack `text`
  // 한계까지 열었다 — 그 한계를 넘는 경우는 아래 send() 절단 테스트가 지킨다.
  it('발췌가 종전 상한(500자)을 넘어도 온전히 나간다', async () => {
    const h = setup({ readFileTail: async () => assistantLine('x'.repeat(600)) })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', { hook_event_name: 'Stop', transcript_path: 'D:\\t.jsonl' })
    await flush()
    expect(h.sent[0]).toContain('x'.repeat(600))
    expect(h.sent[0]).not.toContain('…')
  })

  // 상한을 열었으므로 조합에 따라 Slack 한계를 넘을 수 있다. 넘으면 Slack이 msg_too_long으로
  // 거부해 알림이 조용히 사라지므로, send()가 프리픽스까지 포함한 최종 길이로 한 번 자른다.
  it('Slack 한계를 넘는 메시지는 send가 잘라 보낸다', async () => {
    const h = setup({ readFileTail: async () => assistantLine('x'.repeat(40_500)) })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', { hook_event_name: 'Stop', transcript_path: 'D:\\t.jsonl' })
    await flush()
    expect(h.sent[0].length).toBe(40_000)
    expect(h.sent[0].endsWith('…')).toBe(true)
  })

  it('여러 줄 발췌는 각 줄에 > 인용 접두가 붙는다', async () => {
    const h = setup({ readFileTail: async () => assistantLine('첫 줄\n둘째 줄') })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', { hook_event_name: 'Stop', transcript_path: 'D:\\t.jsonl' })
    await flush()
    expect(h.sent[0]).toContain('> 첫 줄\n> 둘째 줄')
  })

  it('동일 텍스트는 10분 내 재전송하지 않고, 지나면 다시 보낸다', async () => {
    const h = setup()
    h.notifier.register(info())
    const ev = { hook_event_name: 'Notification', message: '같은 메시지' }
    h.notifier.onHookEvent('s-1', ev)
    await flush()
    h.notifier.onHookEvent('s-1', ev)
    await flush()
    expect(h.sent).toHaveLength(1)
    h.advance(10 * 60_000 + 1)
    h.notifier.onHookEvent('s-1', ev)
    await flush()
    expect(h.sent).toHaveLength(2)
  })

  it('URL 미설정이면 아무것도 보내지 않는다', async () => {
    const h = setup()
    h.notifier.setWebhookUrl(null)
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', { hook_event_name: 'Notification', message: 'm' })
    await flush()
    expect(h.sent).toEqual([])
  })

  it('미등록 세션·slackNotify=false 세션은 무시한다', async () => {
    const h = setup()
    h.notifier.register(info({ slackNotify: false }))
    h.notifier.onHookEvent('s-1', { hook_event_name: 'Notification', message: 'm' })
    h.notifier.onHookEvent('unknown', { hook_event_name: 'Notification', message: 'm' })
    await flush()
    expect(h.sent).toEqual([])
  })

  it('계정 조회 실패 시 라벨을 생략한다', async () => {
    const h = setup({ getAccount: () => null })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', { hook_event_name: 'Notification', message: 'm' })
    await flush()
    expect(h.sent[0]).toBe('[myproj] 🙋 입력 필요 — m')
  })

  it('전송 실패(비 2xx·예외)는 로그만 남긴다', async () => {
    const h = setup({
      fetchFn: (async () => ({ ok: false, status: 404 }) as Response) as unknown as typeof fetch
    })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', { hook_event_name: 'Notification', message: 'm' })
    await flush()
    expect(h.logs.some((l) => l.includes('404'))).toBe(true)
  })

  it('전송 실패 시 같은 문구는 dedup에 남지 않아 재발하면 다시 전송한다', async () => {
    let ok = false
    const attempts: string[] = [] // h.sent는 setup 기본 fetchFn 전용이라 여기선 직접 전송 시도를 기록
    const h = setup({
      fetchFn: (async (_url: unknown, init?: RequestInit) => {
        attempts.push((JSON.parse(String(init?.body)) as { text: string }).text)
        return { ok, status: ok ? 200 : 500 } as Response
      }) as unknown as typeof fetch
    })
    h.notifier.register(info())
    const ev = { hook_event_name: 'Notification', message: '입력 필요 반복' }
    h.notifier.onHookEvent('s-1', ev) // 실패
    await flush()
    ok = true
    h.notifier.onHookEvent('s-1', ev) // 실패로 억제 안 됐으니 재전송
    await flush()
    expect(attempts).toHaveLength(2)
  })

  it('전송 예외 로그에 Webhook URL/입력값이 새지 않는다', async () => {
    const secret = 'https://hooks.slack.com/services/T00/B00/XXXSECRET'
    const h = setup({
      fetchFn: (async () => {
        throw new TypeError(`Failed to parse URL from ${secret}`)
      }) as unknown as typeof fetch
    })
    h.notifier.setWebhookUrl(secret)
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', { hook_event_name: 'Notification', message: 'm' })
    await flush()
    expect(h.logs.length).toBeGreaterThan(0)
    expect(h.logs.some((l) => l.includes(secret))).toBe(false)
    expect(h.logs.some((l) => l.includes('SECRET'))).toBe(false)
  })
})

describe('SlackNotifier codex 턴 완료', () => {
  it('codex 턴 완료 — rollout 발췌를 붙여 보낸다', async () => {
    // 현행 codex 형식(core/slack/codexTranscript.ts 의 주석 — 실측 2026-08-29)
    const tail = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '작업을 마쳤습니다' }]
      }
    })
    const h = setup({ readFileTail: async () => tail })
    h.notifier.register(codexSession('s-1'))
    h.notifier.onCodexTurnComplete('s-1', 'D:\\rollout.jsonl')
    await flush()
    expect(h.sent[0]).toContain('✅ 응답 완료')
    expect(h.sent[0]).toContain('작업을 마쳤습니다')
  })

  it('codex 턴 완료 — 발췌를 못 뽑아도 완료 사실은 알린다', async () => {
    const h = setup({ readFileTail: async () => null })
    h.notifier.register(codexSession('s-1'))
    h.notifier.onCodexTurnComplete('s-1', 'D:\\rollout.jsonl')
    await flush()
    expect(h.sent[0]).toContain('✅ 응답 완료')
  })

  it('codex 턴 완료 — 등록되지 않은 세션은 무시한다', async () => {
    const h = setup({ readFileTail: async () => null })
    h.notifier.onCodexTurnComplete('unknown', 'D:\\rollout.jsonl')
    await flush()
    expect(h.sent).toEqual([])
  })
})

describe('SlackNotifier 롤링·한도·종료', () => {
  // 접합으로 쪼갠다 — 통짜면 이 파일이 롤링 세션의 화면으로 흐를 때 스캐너가 물어 실제 롤을
  // 유발한다. 런타임 값은 같다 (rolling.test.ts와 같은 관례).
  const LIMIT_TEXT = 'Claude usage limit ' + 'reached ∙ resets 3am'

  it('rollState waiting(5시간) → 재개 예정 알림 (HH:MM)', async () => {
    const h = setup()
    h.notifier.register(info())
    h.notifier.onRollState({
      sessionId: 's-1', state: 'waiting', nextRetryAt: '2026-07-23T06:30:00.000Z', scope: 'session'
    })
    await flush()
    expect(h.sent[0]).toContain('⏸ 한도 도달')
    expect(h.sent[0]).toContain('재개 예정 (5시간 한도)')
    expect(h.sent[0]).toMatch(/\d{2}:\d{2}/)
  })

  it('rollState waiting(주간) → 날짜 포함 표기 (M/D HH:MM)', async () => {
    const h = setup()
    h.notifier.register(info())
    h.notifier.onRollState({
      sessionId: 's-1', state: 'waiting', nextRetryAt: '2026-07-25T00:00:00.000Z', scope: 'weekly'
    })
    await flush()
    expect(h.sent[0]).toContain('(주간 한도)')
    expect(h.sent[0]).toMatch(/\d{1,2}\/\d{1,2} \d{2}:\d{2}/)
  })

  it('rollState switching → 계정 전환 알림, trust/none은 무시', async () => {
    const h = setup()
    h.notifier.register(info())
    h.notifier.onRollState({ sessionId: 's-1', state: 'trust' })
    h.notifier.onRollState({ sessionId: 's-1', state: 'none' })
    h.notifier.onRollState({ sessionId: 's-1', state: 'switching', accountLabel: 'work2' })
    await flush()
    expect(h.sent).toEqual(['[myproj · work1] 🔁 계정 전환 → work2'])
  })

  it('respawn 후 재부착 switching(reattach)은 같은 전환을 다시 알리지 않는다', async () => {
    const other: Account = { ...account, id: 'acc-2', label: 'work2' }
    const h = setup({ getAccount: (id) => (id === 'acc-2' ? other : account) })
    h.notifier.register(info())
    // 롤 시작(옛 세션 키) → 탭 교체 → 새 세션 키로 배너 재부착. 알림은 첫 번째만.
    h.notifier.onRollState({ sessionId: 's-1', state: 'switching', accountLabel: 'work2' })
    h.notifier.onRolled('s-1', info({ id: 's-2', accountId: 'acc-2' }))
    h.notifier.onRollState({
      sessionId: 's-2', state: 'switching', accountLabel: 'work2', reattach: true
    })
    await flush()
    expect(h.sent).toEqual(['[myproj · work1] 🔁 계정 전환 → work2'])
  })

  it('rollState nudged → 사각지대 자동 재개 알림', async () => {
    const h = setup()
    h.notifier.register(info())
    h.notifier.onRollState({ sessionId: 's-1', state: 'nudged' })
    await flush()
    expect(h.sent).toEqual(['[myproj · work1] ▶️ 한도 리셋 — 자동 재개 프롬프트 전송'])
  })

  it('rollState stalled → nudge 실패 후 사람 호출', async () => {
    const h = setup()
    h.notifier.register(info())
    h.notifier.onRollState({ sessionId: 's-1', state: 'stalled' })
    await flush()
    expect(h.sent).toEqual(['[myproj · work1] ⚠️ 세션이 멈춰 있습니다 — 자동 재개 실패, 확인이 필요합니다'])
  })

  it('onRolled → 새 liveId로 재키잉, 이후 훅 이벤트는 새 id로만 수신', async () => {
    const h = setup()
    h.notifier.register(info())
    h.notifier.onRolled('s-1', info({ id: 's-2', accountId: 'acc-1' }))
    h.notifier.onHookEvent('s-1', { hook_event_name: 'Notification', message: '옛 id' })
    h.notifier.onHookEvent('s-2', { hook_event_name: 'Notification', message: '새 id' })
    await flush()
    expect(h.sent).toEqual(['[myproj · work1] 🙋 입력 필요 — 새 id'])
  })

  it('비롤링 세션 한도: 게이트(≥90%) 통과 시 리셋 시각 포함 알림', async () => {
    const h = setup({
      readStatusPayload: async () => ({
        rate_limits: { five_hour: { used_percentage: 95, resets_at: '2026-07-23T06:30:00.000Z' } }
      })
    })
    h.notifier.register(info())
    h.notifier.handleData({ sessionId: 's-1', data: LIMIT_TEXT })
    await flush()
    expect(h.sent[0]).toContain('⛔ 한도 도달 — 자동 재개 없음')
    expect(h.sent[0]).toContain('리셋')
  })

  it('비롤링 세션 한도: 사용률이 낮아도 문구만으로 알린다 (게이트 제거)', async () => {
    const h = setup({
      readStatusPayload: async () => ({ rate_limits: { five_hour: { used_percentage: 42 } } })
    })
    h.notifier.register(info())
    h.notifier.handleData({ sessionId: 's-1', data: LIMIT_TEXT })
    await flush()
    expect(h.sent[0]).toContain('⛔ 한도 도달 — 자동 재개 없음')
    expect(h.sent[0]).not.toContain('리셋') // 42%는 GATE_PCT 미만이라 reset 표기 대상이 아니다
  })

  it('비롤링 세션 한도: statusline 없으면 정규식 단독 인정(리셋 표기 없음)', async () => {
    const h = setup({ readStatusPayload: async () => null })
    h.notifier.register(info())
    h.notifier.handleData({ sessionId: 's-1', data: LIMIT_TEXT })
    await flush()
    expect(h.sent).toEqual(['[myproj · work1] ⛔ 한도 도달 — 자동 재개 없음'])
  })

  it('롤링 체인 세션(rollAccountIds 있음)은 handleData 한도 감지를 스킵한다', async () => {
    const h = setup({
      readStatusPayload: async () => ({ rate_limits: { five_hour: { used_percentage: 100 } } })
    })
    h.notifier.register(info({ rollAccountIds: ['acc-1', 'acc-2'] }))
    h.notifier.handleData({ sessionId: 's-1', data: LIMIT_TEXT })
    await flush()
    expect(h.sent).toEqual([])
  })

  it('handleExit → 3초 후 종료 알림', async () => {
    vi.useFakeTimers()
    try {
      const h = setup()
      h.notifier.register(info())
      h.notifier.handleExit({ sessionId: 's-1', exitCode: 1 })
      await vi.advanceTimersByTimeAsync(3_000)
      expect(h.sent).toEqual(['[myproj · work1] ⏹ 세션 종료 (exit 1)'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('handleExit 후 3초 안에 onRolled가 오면 종료 알림을 취소한다 (롤링 kill 오탐 방지)', async () => {
    vi.useFakeTimers()
    try {
      const h = setup()
      h.notifier.register(info())
      h.notifier.handleExit({ sessionId: 's-1', exitCode: 0 })
      h.notifier.onRolled('s-1', info({ id: 's-2' }))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(h.sent).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SlackNotifier 비롤링 한도 감지의 provider 분리', () => {
  // 두 정규식은 'usage limit' + ' reached'에서 겹치므로, 실제로 갈리는 문구로만 검증한다.
  //   claude 전용 (detect.ts) : '5-hour limit' / 'session limit' 뒤에 ' reached'
  //   codex 전용  (codexSignal.ts) : "You've hit your <usage> limit"
  // 이 주석의 꺾쇠와 아래 리터럴의 접합은 의도된 것이다 — 통짜면 이 파일 자체가 트리거다
  // (claude·codex 스캐너 양쪽 모두).
  const CLAUDE_ONLY = 'Claude 5-hour limit ' + 'reached ∙ resets 3am'
  const CODEX_ONLY = "You've hit your " + 'usage limit. Upgrade to Plus'

  it('codex 세션: claude 전용 문구로는 알리지 않는다 (거짓 한도 알림의 원인)', async () => {
    const h = setup()
    h.notifier.register(codexSession('s-cx'))
    h.notifier.handleData({ sessionId: 's-cx', data: CLAUDE_ONLY })
    await flush()
    expect(h.sent).toEqual([])
  })

  it('codex 세션: 실측 문구는 statusline 없이도 알린다 — 종전엔 아예 놓쳤다 (리셋 표기 없음)', async () => {
    const h = setup()
    h.notifier.register(codexSession('s-cx'))
    h.notifier.handleData({ sessionId: 's-cx', data: CODEX_ONLY })
    await flush()
    expect(h.sent).toEqual(['[myproj · codex1] ⛔ 한도 도달 — 자동 재개 없음'])
  })

  it('codex 세션: statusline을 아예 조회하지 않는다 (영원히 null인 소스 — scheduler와 같은 게이팅)', async () => {
    const readStatusPayload = vi.fn(async () => null)
    const h = setup({ readStatusPayload })
    h.notifier.register(codexSession('s-cx'))
    h.notifier.handleData({ sessionId: 's-cx', data: CODEX_ONLY })
    await flush()
    expect(h.sent).toHaveLength(1)
    expect(readStatusPayload).not.toHaveBeenCalled()
  })

  it('claude 세션: codex 전용 문구에는 반응하지 않는다 (스캐너가 섞이지 않음)', async () => {
    const h = setup()
    h.notifier.register(info())
    h.notifier.handleData({ sessionId: 's-1', data: CODEX_ONLY })
    await flush()
    expect(h.sent).toEqual([])
  })

  it('claude 세션: 사용률이 낮아도 알린다 — statusline은 reset 시각용으로만 읽는다', async () => {
    const readStatusPayload = vi.fn(async () => ({
      rate_limits: { five_hour: { used_percentage: 42 } }
    }))
    const h = setup({ readStatusPayload })
    h.notifier.register(info())
    h.notifier.handleData({ sessionId: 's-1', data: CLAUDE_ONLY })
    await flush()
    expect(h.sent[0]).toContain('⛔ 한도 도달 — 자동 재개 없음')
    expect(readStatusPayload).toHaveBeenCalledTimes(1) // reset 시각을 얻으려 계속 조회한다
  })

  // 주의: 실제 롤링 체인 세션은 handleData가 rollAccountIds로 먼저 걸러내므로 이 경로는 지금
  // 프로덕션에서 도달하지 않는다. onRolled가 레코드를 만들 때 provider를 잃지 않는다는 계약만
  // 고정한다 — 잃으면 스캐너가 조용히 claude로 바뀐다.
  it('롤링 전환 후에도 codex 스캐너가 유지된다 (onRolled 재키잉)', async () => {
    const h = setup()
    h.notifier.register(codexSession('s-cx'))
    h.notifier.onRolled('s-cx', codexSession('s-cx2'))
    h.notifier.handleData({ sessionId: 's-cx2', data: CLAUDE_ONLY })
    await flush()
    expect(h.sent).toEqual([])
    h.notifier.handleData({ sessionId: 's-cx2', data: CODEX_ONLY })
    await flush()
    expect(h.sent).toEqual(['[myproj · codex1] ⛔ 한도 도달 — 자동 재개 없음'])
  })
})

/** 스레드를 지원하는 가짜 transport — 게시 순서와 threadTs를 기록한다 */
function threadSetup(): {
  notifier: SlackNotifier
  posts: { text: string; threadTs?: string }[]
  logs: string[]
} {
  const posts: { text: string; threadTs?: string }[] = []
  const logs: string[] = []
  let seq = 0
  const transport: SlackTransport = {
    supportsThreads: true,
    post: async (text, threadTs) => {
      posts.push({ text, threadTs })
      return `ts-${++seq}`
    }
  }
  const notifier = new SlackNotifier({
    getAccount: () => account,
    readStatusPayload: async () => null,
    lang: () => 'ko',
    log: (m) => logs.push(m),
    readFileTail: async () => null,
    now: () => 1_000_000
  })
  notifier.setTransport(transport)
  return { notifier, posts, logs }
}

describe('SlackNotifier 세션 스레드', () => {
  it('register가 루트 메시지를 올리고 이후 알림은 그 스레드 답글로 간다', async () => {
    const h = threadSetup()
    h.notifier.register(info())
    await flush()

    expect(h.posts[0]).toMatchObject({ text: expect.stringContaining('myproj'), threadTs: undefined })

    h.notifier.onHookEvent('s-1', { hook_event_name: 'Notification', message: '권한 승인' })
    await flush()

    expect(h.posts[1]).toMatchObject({
      text: '[myproj · work1] 🙋 입력 필요 — 권한 승인',
      threadTs: 'ts-1'
    })
  })

  it('루트 게시가 끝나기 전에 알림이 와도 스레드로 나간다', async () => {
    const posts: { text: string; threadTs?: string }[] = []
    let release: (v: string) => void = () => {}
    const gate = new Promise<string>((r) => (release = r))
    const transport: SlackTransport = {
      supportsThreads: true,
      post: async (text, threadTs) => {
        posts.push({ text, threadTs })
        return posts.length === 1 ? gate : 'ts-x'
      }
    }
    const notifier = new SlackNotifier({
      getAccount: () => account,
      readStatusPayload: async () => null,
      lang: () => 'ko',
      log: () => {},
      readFileTail: async () => null,
      now: () => 1_000_000
    })
    notifier.setTransport(transport)

    notifier.register(info())
    notifier.onHookEvent('s-1', { hook_event_name: 'Notification', message: '먼저 옴' })
    await flush()
    release('ts-root') // 이제서야 루트 게시 완료
    await flush()

    expect(posts[1].threadTs).toBe('ts-root')
  })

  it('스레드 미지원 transport면 루트 메시지를 올리지 않는다', async () => {
    const posts: { text: string; threadTs?: string }[] = []
    const transport: SlackTransport = {
      supportsThreads: false,
      post: async (text, threadTs) => {
        posts.push({ text, threadTs })
        return null
      }
    }
    const notifier = new SlackNotifier({
      getAccount: () => account,
      readStatusPayload: async () => null,
      lang: () => 'ko',
      log: () => {},
      readFileTail: async () => null,
      now: () => 1_000_000
    })
    notifier.setTransport(transport)

    notifier.register(info())
    await flush()
    expect(posts).toEqual([]) // 루트 없음

    notifier.onHookEvent('s-1', { hook_event_name: 'Notification', message: 'x' })
    await flush()
    expect(posts[0].threadTs).toBeUndefined()
  })

  it('루트 게시 실패는 로그만 남기고 알림은 채널로 나간다', async () => {
    const logs: string[] = []
    const posts: { text: string; threadTs?: string }[] = []
    const transport: SlackTransport = {
      supportsThreads: true,
      post: async (text, threadTs) => {
        if (posts.length === 0) {
          posts.push({ text, threadTs })
          throw new SlackPostError('status=403')
        }
        posts.push({ text, threadTs })
        return 'ts-2'
      }
    }
    const notifier = new SlackNotifier({
      getAccount: () => account,
      readStatusPayload: async () => null,
      lang: () => 'ko',
      log: (m) => logs.push(m),
      readFileTail: async () => null,
      now: () => 1_000_000
    })
    notifier.setTransport(transport)

    notifier.register(info())
    await flush()
    notifier.onHookEvent('s-1', { hook_event_name: 'Notification', message: 'y' })
    await flush()

    expect(logs.some((l) => l.includes('status=403'))).toBe(true)
    expect(posts[1].threadTs).toBeUndefined() // 스레드 없이 채널로
  })

  it('계정 롤링으로 세션 id가 바뀌어도 같은 스레드에 붙는다', async () => {
    const h = threadSetup()
    h.notifier.register(info())
    await flush()
    expect(h.posts).toHaveLength(1) // 루트만

    h.notifier.onRolled('s-1', info({ id: 's-2' }))
    h.notifier.onHookEvent('s-2', { hook_event_name: 'Notification', message: '전환 후' })
    await flush()

    expect(h.posts).toHaveLength(2) // 루트를 새로 만들지 않았다
    expect(h.posts[1].threadTs).toBe('ts-1') // 같은 스레드
  })

  it('old가 없으면 onRolled()에서 새 스레드를 연다', async () => {
    const h = threadSetup()
    // register 하지 않음 — old('s-1')가 없는 상태에서 onRolled만 호출
    h.notifier.onRolled('s-1', info({ id: 's-2' }))
    h.notifier.onHookEvent('s-2', { hook_event_name: 'Notification', message: '롤링 후' })
    await flush()

    // 루트 메시지가 새로 생성되어야 함 (폴백: if (!record.thread) record.thread = this.openThread(record))
    expect(h.posts).toHaveLength(2) // 루트 + 알림
    expect(h.posts[0].threadTs).toBeUndefined() // 루트는 스레드 없음
    expect(h.posts[1].threadTs).toBe('ts-1') // 알림은 루트 스레드에 붙음
  })
})

describe('SlackConfigStore', () => {
  it('저장 후 로드 왕복, 빈 문자열은 null로 정규화, 파일 없음/손상은 기본값', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slack-'))
    try {
      const store = new SlackConfigStore(path.join(dir, 'slack.json'))
      expect(await store.load()).toEqual(cfg()) // 파일 없음
      await store.save(cfg({ webhookUrl: 'https://hooks.slack.com/x' }))
      expect(await store.load()).toEqual(cfg({ webhookUrl: 'https://hooks.slack.com/x' }))
      await store.save(cfg())
      expect(await store.load()).toEqual(cfg())
      await fs.writeFile(path.join(dir, 'slack.json'), '{broken', 'utf8')
      expect(await store.load()).toEqual(cfg()) // 손상
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe('SlackConfigStore 확장 (봇 토큰·채널·appToken)', () => {
  it('botToken·channelId·appToken을 저장하고 다시 읽는다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-'))
    const store = new SlackConfigStore(path.join(dir, 'slack.json'))

    await store.save(
      cfg({ webhookUrl: 'https://hooks/x', botToken: 'xoxb-1', channelId: 'C1', appToken: 'xapp-1' })
    )

    expect(await store.load()).toEqual(
      cfg({ webhookUrl: 'https://hooks/x', botToken: 'xoxb-1', channelId: 'C1', appToken: 'xapp-1' })
    )
  })

  it('파일이 없으면 전부 null', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-'))
    const store = new SlackConfigStore(path.join(dir, 'none.json'))

    expect(await store.load()).toEqual(cfg())
  })

  it('기존 webhookUrl만 있는 파일도 읽힌다 (하위 호환)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-'))
    const file = path.join(dir, 'slack.json')
    await fs.writeFile(file, JSON.stringify({ webhookUrl: 'https://hooks/old' }), 'utf8')

    expect(await new SlackConfigStore(file).load()).toEqual(cfg({ webhookUrl: 'https://hooks/old' }))
  })

  it('봇 토큰·채널만 있고 appToken이 없는 파일도 읽힌다 (옛 설정과의 하위 호환)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-'))
    const file = path.join(dir, 'slack.json')
    await fs.writeFile(file, JSON.stringify({ botToken: 'xoxb-old', channelId: 'C-old' }), 'utf8')

    expect(await new SlackConfigStore(file).load()).toEqual(
      cfg({ botToken: 'xoxb-old', channelId: 'C-old' })
    )
  })

  it('빈 문자열은 null로 정규화한다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-'))
    const store = new SlackConfigStore(path.join(dir, 'slack.json'))

    await store.save(cfg({ webhookUrl: '  ', botToken: '', channelId: 'C1', appToken: '   ' }))

    expect(await store.load()).toEqual(cfg({ channelId: 'C1' }))
  })
})

describe('SlackConfigStore.patch', () => {
  it('보내지 않은 필드(undefined)는 기존 값을 보존한다 — 웹훅 저장이 봇 토큰을 지우지 않는다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-patch-'))
    const store = new SlackConfigStore(path.join(dir, 'slack.json'))
    await store.save(cfg({ botToken: 'xoxb-1', channelId: 'C1' }))

    // 한 필드만 보내는 호출이 회귀의 재현이다 — 나머지가 살아남아야 한다.
    const result = await store.patch({ webhookUrl: 'https://hooks.slack.com/new' })

    expect(result).toEqual(
      cfg({ webhookUrl: 'https://hooks.slack.com/new', botToken: 'xoxb-1', channelId: 'C1' })
    )
    expect(await store.load()).toEqual(result) // 디스크에도 병합된 값이 저장됐다
  })

  it('명시적으로 null을 보낸 필드는 지운다 — undefined(미전송)와 null(명시적 삭제)을 구별한다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-patch-'))
    const store = new SlackConfigStore(path.join(dir, 'slack.json'))
    await store.save(cfg({ webhookUrl: 'https://hooks/x', botToken: 'xoxb-1', channelId: 'C1' }))

    const result = await store.patch({ botToken: null })

    expect(result).toEqual(cfg({ webhookUrl: 'https://hooks/x', channelId: 'C1' }))
  })

  it('파일이 없는 상태에서 patch()는 빈 기본값을 기준으로 병합한다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-patch-'))
    const store = new SlackConfigStore(path.join(dir, 'none.json'))

    const result = await store.patch({ channelId: 'C9' })

    expect(result).toEqual(cfg({ channelId: 'C9' }))
  })

  // 파일이 있는데 읽히지 않는 경우가 값을 잃을 수 있는 유일한 길이다. load()는 앱을 막지 않으려고 전부
  // null로 폴백하는데, patch()가 그 폴백 위에 병합하면 디스크에 살아 있는 토큰이 한 번의 저장으로 null이
  // 된다. 읽기만 실패하고 쓰기는 되는 상태가 재현 조건이므로(Windows의 EPERM·EBUSY, fd 부족의 EMFILE 같은
  // 일시적 실패) readFile을 직접 실패시킨다 — 경로 자체를 못 쓰게 만들면 save()도 같이 실패해서 테스트가
  // 엉뚱한 이유로 통과한다.
  it('읽기가 실패하면(파일 없음이 아니라) 저장하지 않고 던진다 — 살아 있는 값을 null로 덮지 않는다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-patch-'))
    const file = path.join(dir, 'slack.json')
    const store = new SlackConfigStore(file)
    await store.save(cfg({ botToken: 'xoxb-1', channelId: 'C1', appToken: 'xapp-1' }))
    const onDisk = await fs.readFile(file, 'utf8')

    const spy = vi
      .spyOn(fs, 'readFile')
      .mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
    try {
      await expect(store.patch({ webhookUrl: 'https://hooks/new' })).rejects.toThrow(/slack\.json/)
    } finally {
      spy.mockRestore()
    }

    expect(await fs.readFile(file, 'utf8')).toBe(onDisk) // 토큰은 그대로 남아 있다
  })

  it('읽기 실패는 load()를 막지 않는다 — 기본값으로 폴백해 앱은 계속 뜬다', async () => {
    const spy = vi
      .spyOn(fs, 'readFile')
      .mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
    try {
      expect(await new SlackConfigStore('whatever/slack.json').load()).toEqual(cfg())
    } finally {
      spy.mockRestore()
    }
  })

  // 손상된 파일은 읽기 실패와 달리 다시 시도해도 되돌아오지 않는다. 여기서도 던지면 설정 화면에서 고칠 길이
  // 없어지므로 덮어쓰기를 허용한다 — 잃을 값이 애초에 없다.
  it('손상된 파일은 patch()로 덮어쓸 수 있다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-patch-'))
    const file = path.join(dir, 'slack.json')
    await fs.writeFile(file, '{broken', 'utf8')
    const store = new SlackConfigStore(file)

    const result = await store.patch({ channelId: 'C9' })

    expect(result).toEqual(cfg({ channelId: 'C9' }))
    expect(await store.load()).toEqual(result)
  })

  it('빈 객체로 patch()해도 기존 값이 그대로 유지된다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-patch-'))
    const store = new SlackConfigStore(path.join(dir, 'slack.json'))
    await store.save(cfg({ webhookUrl: 'https://hooks/x', botToken: 'xoxb-1', channelId: 'C1' }))

    const result = await store.patch({})

    expect(result).toEqual(cfg({ webhookUrl: 'https://hooks/x', botToken: 'xoxb-1', channelId: 'C1' }))
  })

  it('appToken만 갱신해도 봇 토큰·채널이 보존된다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-patch-'))
    const store = new SlackConfigStore(path.join(dir, 'slack.json'))
    await store.save(cfg({ botToken: 'xoxb-1', channelId: 'C1' }))

    const result = await store.patch({ appToken: 'xapp-9' })

    expect(result).toEqual(cfg({ botToken: 'xoxb-1', channelId: 'C1', appToken: 'xapp-9' }))
  })

  it('appToken은 전송 경로 선택에 영향을 주지 않는다 — 봇 판정은 botToken+channelId만 본다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-patch-'))
    const store = new SlackConfigStore(path.join(dir, 'slack.json'))

    // appToken만 있으면 봇 모드가 아니다 — isSlackReady도 false여야 한다
    const onlyApp = await store.patch({ appToken: 'xapp-1' })
    expect(isSlackReady(onlyApp)).toBe(false)

    // 봇 토큰+채널이 채워지면 appToken 유무와 무관하게 준비 완료다
    const withBot = await store.patch({ botToken: 'xoxb-1', channelId: 'C1' })
    expect(isSlackReady(withBot)).toBe(true)
  })
})

describe('SlackConfigStore — memberId', () => {
  it('memberId를 저장하고 다시 읽는다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-member-'))
    const store = new SlackConfigStore(path.join(dir, 'slack.json'))

    await store.save(cfg({ botToken: 'xoxb-1', channelId: 'C1', memberId: 'U-owner' }))

    expect(await store.load()).toEqual(
      cfg({ botToken: 'xoxb-1', channelId: 'C1', memberId: 'U-owner' })
    )
  })

  it('memberId가 없는 옛 파일은 null로 읽힌다 — 마이그레이션 없이 차단 쪽으로 수렴한다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-member-'))
    const file = path.join(dir, 'slack.json')
    await fs.writeFile(
      file,
      JSON.stringify({ botToken: 'xoxb-old', channelId: 'C-old', appToken: 'xapp-old' }),
      'utf8'
    )

    expect(await new SlackConfigStore(file).load()).toEqual(
      cfg({ botToken: 'xoxb-old', channelId: 'C-old', appToken: 'xapp-old' })
    )
  })

  it('공백만 있는 memberId는 null로 정규화한다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-member-'))
    const store = new SlackConfigStore(path.join(dir, 'slack.json'))

    await store.save(cfg({ channelId: 'C1', memberId: '   ' }))

    expect(await store.load()).toEqual(cfg({ channelId: 'C1' }))
  })

  it('memberId만 갱신해도 토큰·채널이 보존된다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-member-'))
    const store = new SlackConfigStore(path.join(dir, 'slack.json'))
    await store.save(cfg({ botToken: 'xoxb-1', channelId: 'C1', appToken: 'xapp-1' }))

    const result = await store.patch({ memberId: 'U-owner' })

    expect(result).toEqual(
      cfg({ botToken: 'xoxb-1', channelId: 'C1', appToken: 'xapp-1', memberId: 'U-owner' })
    )
  })

  it('다른 필드만 patch해도 memberId는 살아남는다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-member-'))
    const store = new SlackConfigStore(path.join(dir, 'slack.json'))
    await store.save(cfg({ botToken: 'xoxb-1', channelId: 'C1', memberId: 'U-owner' }))

    const result = await store.patch({ appToken: 'xapp-9' })

    expect(result.memberId).toBe('U-owner')
  })

  it('memberId는 전송 경로 선택에 영향을 주지 않는다 — 수신 권한이지 전송 조건이 아니다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-member-'))
    const store = new SlackConfigStore(path.join(dir, 'slack.json'))

    // memberId만 있으면 보낼 경로가 없다
    const onlyMember = await store.patch({ memberId: 'U-owner' })
    expect(isSlackReady(onlyMember)).toBe(false)

    // 봇 토큰+채널이 채워지면 memberId를 지워도 전송은 준비 완료다 (답장 주입만 막힌다)
    const withBot = await store.patch({ botToken: 'xoxb-1', channelId: 'C1', memberId: null })
    expect(isSlackReady(withBot)).toBe(true)
  })
})

describe('SlackNotifier.applyConfig', () => {
  const make = (): { notifier: SlackNotifier; posts: string[] } => {
    const posts: string[] = []
    const notifier = new SlackNotifier({
      getAccount: () => account,
      readStatusPayload: async () => null,
      lang: () => 'ko',
      log: () => {},
      readFileTail: async () => null,
      now: () => 1_000_000,
      fetchFn: (async (_u: unknown, init?: RequestInit) => {
        posts.push((JSON.parse(String(init?.body)) as { text: string }).text)
        return { ok: true, status: 200 } as Response
      }) as unknown as typeof fetch,
      createPoster: () => ({
        chat: {
          postMessage: async (a: { text: string }) => {
            posts.push(`BOT:${a.text}`)
            return { ok: true, ts: 'ts-1' }
          }
        }
      })
    })
    return { notifier, posts }
  }

  it('botToken+channelId가 있으면 봇 경로로 보낸다', async () => {
    const h = make()
    h.notifier.applyConfig({ webhookUrl: 'https://hooks/x', botToken: 'xoxb-1', channelId: 'C1' })
    h.notifier.register(info())
    await flush()
    expect(h.posts[0]).toContain('BOT:')
  })

  it('botToken만 있고 channelId가 없으면 webhook으로 떨어진다', async () => {
    const h = make()
    h.notifier.applyConfig({ webhookUrl: 'https://hooks/x', botToken: 'xoxb-1', channelId: null })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', { hook_event_name: 'Notification', message: 'z' })
    await flush()
    expect(h.posts.every((p) => !p.startsWith('BOT:'))).toBe(true)
  })

  it('둘 다 없으면 아무것도 보내지 않는다', async () => {
    const h = make()
    h.notifier.applyConfig({ webhookUrl: null, botToken: null, channelId: null })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', { hook_event_name: 'Notification', message: 'z' })
    await flush()
    expect(h.posts).toEqual([])
  })
})

describe('SlackNotifier transport 교체 시 스레드 리셋', () => {
  it('채널이 바뀌면 살아있는 세션의 옛 스레드 ts를 버리고, 다음 알림에서 새 채널에 새 루트를 연다', async () => {
    const calls: { channel: string; text: string; thread_ts?: string }[] = []
    let seq = 0
    const notifier = new SlackNotifier({
      getAccount: () => account,
      readStatusPayload: async () => null,
      lang: () => 'ko',
      log: () => {},
      readFileTail: async () => null,
      now: () => 1_000_000,
      createPoster: () => ({
        chat: {
          postMessage: async (a) => {
            calls.push(a)
            return { ok: true, ts: `ts-${++seq}` }
          }
        }
      })
    })

    notifier.applyConfig({ webhookUrl: null, botToken: 'xoxb-1', channelId: 'C1' })
    notifier.register(info())
    await flush()
    expect(calls).toEqual([{ channel: 'C1', text: expect.stringContaining('myproj') }]) // 루트만, C1

    // 채널 전환 — 옛 C1의 ts를 그대로 들고 있었다면 이후 답글이 C1의 ts를 C2로 잘못 보내 실패한다.
    notifier.applyConfig({ webhookUrl: null, botToken: 'xoxb-1', channelId: 'C2' })
    notifier.onHookEvent('s-1', { hook_event_name: 'Notification', message: '전환 후 알림' })
    await flush()

    // 리셋됐다면: 새 루트(C2, thread_ts 없음)가 먼저 나가고, 그 다음 답글이 그 새 루트에 붙는다.
    expect(calls).toHaveLength(3)
    expect(calls[1].channel).toBe('C2')
    expect(calls[1].thread_ts).toBeUndefined() // 새 루트 — C1의 ts를 안 물려받았다
    expect(calls[2]).toEqual({ channel: 'C2', text: expect.stringContaining('전환 후 알림'), thread_ts: 'ts-2' })
  })

  it('봇 모드를 켜기 전에 등록된 세션도 이후 전환되면 스레드가 새로 열린다', async () => {
    const calls: { channel: string; text: string; thread_ts?: string }[] = []
    let seq = 0
    const notifier = new SlackNotifier({
      getAccount: () => account,
      readStatusPayload: async () => null,
      lang: () => 'ko',
      log: () => {},
      readFileTail: async () => null,
      now: () => 1_000_000,
      fetchFn: (async () => ({ ok: true, status: 200 }) as Response) as unknown as typeof fetch,
      createPoster: () => ({
        chat: {
          postMessage: async (a) => {
            calls.push(a)
            return { ok: true, ts: `ts-${++seq}` }
          }
        }
      })
    })

    // webhook 모드로 등록 — 스레드 미지원이라 record.thread는 계속 null
    notifier.applyConfig({ webhookUrl: 'https://hooks/x', botToken: null, channelId: null })
    notifier.register(info())
    await flush()
    expect(calls).toEqual([]) // 봇 호출 없음(webhook 경로)

    // 이제 봇 모드로 전환
    notifier.applyConfig({ webhookUrl: null, botToken: 'xoxb-1', channelId: 'C1' })
    notifier.onHookEvent('s-1', { hook_event_name: 'Notification', message: 'x' })
    await flush()

    expect(calls).toHaveLength(2) // 루트 + 알림, 둘 다 봇 경로로
    expect(calls[0].thread_ts).toBeUndefined()
    expect(calls[1].thread_ts).toBe('ts-1')
  })
})

describe('SlackNotifier 스레드 역매핑', () => {
  it('루트 게시가 끝나면 threadTs로 세션을 되짚을 수 있다', async () => {
    const h = threadSetup()
    h.notifier.register(info())
    await flush()

    expect(h.notifier.resolveSessionByThread('ts-1')).toBe('s-1')
    expect(h.notifier.resolveSessionByThread('ts-없음')).toBeNull()
  })

  it('스레드 미지원(webhook) 경로에서는 색인이 비어 있다', async () => {
    const posts: { text: string; threadTs?: string }[] = []
    const notifier = new SlackNotifier({
      getAccount: () => account,
      readStatusPayload: async () => null,
      lang: () => 'ko',
      log: () => {},
      readFileTail: async () => null,
      now: () => 1_000_000
    })
    notifier.setTransport({
      supportsThreads: false,
      post: async (text, threadTs) => {
        posts.push({ text, threadTs })
        return null
      }
    })
    notifier.register(info())
    await flush()

    expect(notifier.resolveSessionByThread('ts-1')).toBeNull()
  })

  it('세션이 종료되면 색인에서 빠진다 — 이후 답장은 "종료됨" 안내를 받아야 한다', async () => {
    const h = threadSetup()
    h.notifier.register(info())
    await flush() // 루트 게시 resolve → 색인 등록 (실제 타이머로 처리해야 한다)
    expect(h.notifier.resolveSessionByThread('ts-1')).toBe('s-1')

    // 종료 알림은 3초 지연이고 그 콜백에서 색인을 지운다 (기존 handleExit 테스트와 같은 방식)
    vi.useFakeTimers()
    try {
      h.notifier.handleExit({ sessionId: 's-1', exitCode: 0 })
      await vi.advanceTimersByTimeAsync(3_000)
    } finally {
      vi.useRealTimers()
    }

    expect(h.notifier.resolveSessionByThread('ts-1')).toBeNull()
  })

  it('계정 롤링으로 세션 id가 바뀌면 색인이 새 id를 가리킨다', async () => {
    const h = threadSetup()
    h.notifier.register(info())
    await flush()
    expect(h.notifier.resolveSessionByThread('ts-1')).toBe('s-1')

    h.notifier.onRolled('s-1', info({ id: 's-2' }))
    await flush()

    // 같은 스레드가 살아있는 새 세션을 가리켜야 한다 — 옛 id로 남으면 주입이 죽은 세션으로 간다
    expect(h.notifier.resolveSessionByThread('ts-1')).toBe('s-2')
  })

  it('slackNotify가 꺼진 채로 재키잉되면 색인에서 사라진다', async () => {
    const h = threadSetup()
    h.notifier.register(info())
    await flush()

    h.notifier.onRolled('s-1', info({ id: 's-3', slackNotify: false }))
    await flush()

    expect(h.notifier.resolveSessionByThread('ts-1')).toBeNull()
  })

  it('postThreadNote는 알림 프리픽스·dedup 없이 그 스레드에 답글만 남긴다', async () => {
    const h = threadSetup()
    h.notifier.register(info())
    await flush()
    const before = h.posts.length

    await h.notifier.postThreadNote('ts-1', '⚠️ 전달하지 못했습니다')
    await h.notifier.postThreadNote('ts-1', '⚠️ 전달하지 못했습니다') // 같은 텍스트 재전송도 막지 않는다

    expect(h.posts.slice(before)).toEqual([
      { text: '⚠️ 전달하지 못했습니다', threadTs: 'ts-1' },
      { text: '⚠️ 전달하지 못했습니다', threadTs: 'ts-1' }
    ])
  })

  it('transport 교체 시 threadIndex도 함께 비운다 — 봇 모드를 꺼도 옛 ts로 주입되면 안 된다', async () => {
    const h = threadSetup()
    h.notifier.register(info())
    await flush()
    expect(h.notifier.resolveSessionByThread('ts-1')).toBe('s-1')

    // 봇 모드를 끄는 것과 같은 효과 — transport가 교체(null 포함)되면 옛 채널의 ts는 더 이상 유효하지 않다
    h.notifier.setTransport(null)

    expect(h.notifier.resolveSessionByThread('ts-1')).toBeNull()
  })

  it('루트 게시가 느리게 끝나는 사이 세션이 죽으면 색인에 되살리지 않는다 — 유령 색인', async () => {
    vi.useFakeTimers()
    try {
      let releaseRoot: (ts: string | null) => void = () => {}
      const rootGate = new Promise<string | null>((r) => (releaseRoot = r))
      let call = 0
      const transport: SlackTransport = {
        supportsThreads: true,
        post: async () => {
          call++
          if (call === 1) return rootGate // 루트 게시 — 세션이 죽을 때까지 resolve되지 않는다
          return `ts-later-${call}` // 종료 알림 등 이후 게시는 즉시 resolve
        }
      }
      const notifier = new SlackNotifier({
        getAccount: () => account,
        readStatusPayload: async () => null,
        lang: () => 'ko',
        log: () => {},
        readFileTail: async () => null,
        now: () => 1_000_000
      })
      notifier.setTransport(transport)

      notifier.register(info()) // 루트 게시 시작(rootGate 대기 중) — 아직 resolve 안 됨
      notifier.handleExit({ sessionId: 's-1', exitCode: 0 }) // 세션이 죽는다
      await vi.advanceTimersByTimeAsync(3_000) // 3초 후 exit 콜백이 레코드를 정리한다(records.delete)

      // 이제서야 루트 게시가 늦게 resolve된다 — 죽은 세션의 ts가 뒤늦게 들어온다
      releaseRoot('ts-ghost')
      await vi.advanceTimersByTimeAsync(0)

      // 색인에 되살아나면 안 된다 — 살아있지 않은 세션에 영구히 주입되는 통로가 된다
      expect(notifier.resolveSessionByThread('ts-ghost')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SlackNotifier.isOwnMessage — 루프 방어 2차', () => {
  it('우리가 게시한 ts는(루트·알림·스레드 노트 어느 경로든) own으로 판정한다', async () => {
    const h = threadSetup()
    h.notifier.register(info())
    await flush()
    expect(h.notifier.isOwnMessage('ts-1')).toBe(true) // 루트

    h.notifier.onHookEvent('s-1', { hook_event_name: 'Notification', message: 'x' })
    await flush()
    expect(h.notifier.isOwnMessage('ts-2')).toBe(true) // 알림 답글

    await h.notifier.postThreadNote('ts-1', '안내')
    expect(h.notifier.isOwnMessage('ts-3')).toBe(true) // 스레드 노트
  })

  it('우리가 게시하지 않은 ts는 own이 아니다', () => {
    const h = threadSetup()
    expect(h.notifier.isOwnMessage('ts-무관')).toBe(false)
  })
})

describe('SlackNotifier 대기 중 선택지 전송', () => {
  const ASK_LINE = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 't1',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: '어떻게 진행할까?',
                header: '진행',
                multiSelect: false,
                options: [
                  { label: '지금 고친다', description: '이번 브랜치에서' },
                  { label: '나중에', description: '별도 티켓으로' }
                ]
              }
            ]
          }
        }
      ]
    }
  })
  const ANSWERED = [
    ASK_LINE,
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } })
  ].join('\n')
  const PERMISSION_LINE = JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 'p1', name: 'Bash', input: { command: 'rm -rf build/' } }]
    }
  })

  it('질문 내용과 선택지를 알림에 담는다 — message도 함께 온다', async () => {
    const h = setup({ readFileTail: async () => ASK_LINE })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', {
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your input',
      transcript_path: 'D:\\t.jsonl'
    })
    await flush()
    // 형식: 🙋 입력 필요 — {message}\n{pending} — message를 버리지 않고 pending과 나란히 둔다
    expect(h.sent[0]).toBe(
      '[myproj · work1] 🙋 입력 필요 — Claude needs your input\n' +
        '❓ 어떻게 진행할까?\n1. 지금 고친다 — 이번 브랜치에서\n2. 나중에 — 별도 티켓으로'
    )
  })

  it('message가 비어 있으면 pending만 담는다', async () => {
    const h = setup({ readFileTail: async () => ASK_LINE })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', {
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: '',
      transcript_path: 'D:\\t.jsonl'
    })
    await flush()
    expect(h.sent[0]).toBe(
      '[myproj · work1] 🙋 입력 필요\n❓ 어떻게 진행할까?\n1. 지금 고친다 — 이번 브랜치에서\n2. 나중에 — 별도 티켓으로'
    )
  })

  it('message와 pending이 서로 다른 대상을 가리켜도 둘 다 보여준다 — 서브에이전트 실행 중 바깥 Task가 계속 ' +
    '미응답으로 남는 경우가 그렇다', async () => {
    const h = setup({ readFileTail: async () => PERMISSION_LINE })
    h.notifier.register(info())
    // 이 알림이 pending과 같은 이야기인지 사용자가 대조할 수 있어야 하므로 message를 버리지 않는다.
    h.notifier.onHookEvent('s-1', {
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use WebFetch',
      transcript_path: 'D:\\t.jsonl'
    })
    await flush()
    expect(h.sent[0]).toBe(
      '[myproj · work1] 🙋 입력 필요 — Claude needs your permission to use WebFetch\n' +
        '🔧 Bash\ncommand: rm -rf build/'
    )
  })

  // 실측(현재 번들의 emit 지점): auth_success = "Claude Code login successful",
  // agent_completed = "<label> finished/failed", elicitation_complete = "…confirmed elicitation N
  // complete", elicitation_response = "Elicitation response for server …" — 모두 이미 지나간 일에 대한
  // 통보이고 답을 기다리는 화면이 아니다. 그런데 종전에는 idle_prompt만 예외였고 나머지는 pending이
  // 있으면(혹은 message만 있어도) 전부 `🙋 입력 필요`로 나갔다. 문구는 살리고 프레이밍만 걷어낸다 —
  // 통보 자체는 사용자가 알아야 할 수 있고, 지우는 쪽은 되돌릴 수 없다.
  it('대기 화면이 아닌 타입은 입력 필요로 보내지 않는다 — 문구만 전달한다', async () => {
    for (const type of ['auth_success', 'agent_completed', 'elicitation_complete', 'elicitation_response']) {
      const h = setup({ readFileTail: async () => PERMISSION_LINE })
      h.notifier.register(info())
      h.notifier.onHookEvent('s-1', {
        hook_event_name: 'Notification',
        notification_type: type,
        message: '워커 작업이 끝났습니다',
        transcript_path: 'D:\\t.jsonl'
      })
      await flush()
      expect(h.sent).toEqual(['[myproj · work1] 워커 작업이 끝났습니다'])
    }
  })

  it('대기 화면이 아닌 타입은 문구가 비어 있으면 아무것도 보내지 않는다', async () => {
    const h = setup({ readFileTail: async () => PERMISSION_LINE })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', {
      hook_event_name: 'Notification',
      notification_type: 'agent_completed',
      message: '',
      transcript_path: 'D:\\t.jsonl'
    })
    await flush()
    expect(h.sent).toEqual([])
  })

  it('agent_needs_input은 대기 화면이므로 그대로 입력 필요로 보낸다 (회귀 가드)', async () => {
    const h = setup({ readFileTail: async () => PERMISSION_LINE })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', {
      hook_event_name: 'Notification',
      notification_type: 'agent_needs_input',
      message: 'worker-1 needs your input',
      transcript_path: 'D:\\t.jsonl'
    })
    await flush()
    expect(h.sent[0]).toContain('🙋 입력 필요 — worker-1 needs your input')
    expect(h.sent[0]).toContain('🔧 Bash')
  })

  it('유휴 알림이어도 대기 중 질문이 있으면 보낸다 — 진짜 답을 기다리는 화면이다', async () => {
    const h = setup({ readFileTail: async () => ASK_LINE })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', {
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: 'Claude is waiting for your input',
      transcript_path: 'D:\\t.jsonl'
    })
    await flush()
    expect(h.sent[0]).toContain('어떻게 진행할까?')
    expect(h.sent[0]).toContain('Claude is waiting for your input') // 유휴 문구도 버리지 않는다
  })

  it('유휴 알림 + 대기 중 질문 없음 → 종전대로 억제한다 (롤링 오탐 방지 유지)', async () => {
    const h = setup({ readFileTail: async () => ANSWERED })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', {
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: 'Claude is waiting for your input',
      transcript_path: 'D:\\t.jsonl'
    })
    await flush()
    expect(h.sent).toEqual([])
  })

  it('권한 승인 대기는 무엇을 하려는지 도구와 인자로 알린다', async () => {
    const h = setup({ readFileTail: async () => PERMISSION_LINE })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', {
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
      transcript_path: 'D:\\t.jsonl'
    })
    await flush()
    expect(h.sent[0]).toContain('Bash')
    expect(h.sent[0]).toContain('rm -rf build/')
  })

  it('transcript를 못 읽으면 종전 한 줄 알림으로 떨어진다', async () => {
    const h = setup({ readFileTail: async () => null })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', {
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: '권한 승인이 필요합니다',
      transcript_path: 'D:\\t.jsonl'
    })
    await flush()
    expect(h.sent).toEqual(['[myproj · work1] 🙋 입력 필요 — 권한 승인이 필요합니다'])
  })

  it('transcript_path가 없어도 종전 동작을 유지한다', async () => {
    const h = setup()
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', {
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'm'
    })
    await flush()
    expect(h.sent).toEqual(['[myproj · work1] 🙋 입력 필요 — m'])
  })

  it('처음 보는 notification_type은 로그로 남긴다 — 목록 갱신 시점을 알기 위해', async () => {
    const h = setup({ readFileTail: async () => ASK_LINE })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', {
      hook_event_name: 'Notification',
      notification_type: 'brand_new_type',
      message: 'm',
      transcript_path: 'D:\\t.jsonl'
    })
    await flush()
    expect(h.logs.some((l) => l.includes('brand_new_type'))).toBe(true)
    expect(h.sent[0]).toContain('어떻게 진행할까?') // 그래도 전송은 된다
  })

  it('현재 번들의 타입들은 처음 보는 것으로 취급하지 않는다', async () => {
    for (const t of ['permission_prompt', 'elicitation_dialog', 'agent_needs_input', 'agent_completed']) {
      const h = setup({ readFileTail: async () => ASK_LINE })
      h.notifier.register(info())
      h.notifier.onHookEvent('s-1', {
        hook_event_name: 'Notification',
        notification_type: t,
        message: 'm',
        transcript_path: 'D:\\t.jsonl'
      })
      await flush()
      expect(h.logs.some((l) => l.includes('처음 보는'))).toBe(false)
    }
  })
})

describe('SlackNotifier PreToolUse 대기 내용 캡처', () => {
  const ASK = {
    questions: [{ question: '뭐 드실래요?', options: [{ label: '짜장면' }, { label: '짬뽕' }] }]
  }
  const useLine = (id: string, name: string, input: unknown): string =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
  const resultLine = (id: string): string =>
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } })
  // tool_use_id는 실제 페이로드에 항상 실려 온다 (실측: toolu_018w5xYGEUJwXzuf3KF8RnN3).
  // 대기 여부 판정의 근거이므로 픽스처도 그것을 담는다 — 기본값은 꼬리에 없는 id다.
  const pre = (name: string, input: unknown, id = 't-new'): Record<string, unknown> => ({
    hook_event_name: 'PreToolUse',
    tool_name: name,
    tool_input: input,
    tool_use_id: id,
    transcript_path: 'D:\\t.jsonl'
  })
  const notify = (message: string): Record<string, unknown> => ({
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
    message,
    transcript_path: 'D:\\t.jsonl'
  })

  // 아래 테스트들이 readFileTail로 빈 꼬리를 주는 건 실측을 옮긴 것이다: Claude Code는
  // 상호작용 대기 중 assistant 메시지를 flush하지 않아, 알림을 보내는 그 시점 꼬리에 대기 중인
  // tool_use가 없다. transcript만 보는 종전 경로가 이 상황에서 아무것도 못 찾는 이유다.
  it('질문이 떠 있는 동안 transcript가 비어도 선택지를 알림에 담는다', async () => {
    const h = setup({ readFileTail: async () => '' })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', pre('AskUserQuestion', ASK))
    await flush()
    h.notifier.onHookEvent('s-1', notify('Claude needs your permission'))
    await flush()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toContain('입력 필요 — Claude needs your permission')
    expect(h.sent[0]).toContain('❓ 뭐 드실래요?')
    expect(h.sent[0]).toContain('1. 짜장면')
    expect(h.sent[0]).toContain('2. 짬뽕')
  })

  it('권한 승인 대기도 무엇을 승인하는지 담는다 — 이쪽도 transcript에는 없다', async () => {
    const h = setup({ readFileTail: async () => '' })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', pre('Write', { file_path: 'D:\\p\\a.txt', content: '본문' }))
    await flush()
    h.notifier.onHookEvent('s-1', notify('Claude needs your permission'))
    await flush()
    expect(h.sent[0]).toContain('Write')
    expect(h.sent[0]).toContain('a.txt')
  })

  it('호출이 끝나 기록되면(id 출현) 캐시를 버린다 — 옛 내용이 다음 알림에 실리지 않는다', async () => {
    let tail = ''
    const h = setup({ readFileTail: async () => tail })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', pre('AskUserQuestion', ASK, 't1')) // 아래 꼬리에 기록되는 그 호출
    await flush()
    // 답하면 tool_use와 tool_result가 한 묶음으로 기록된다
    tail = [useLine('t1', 'AskUserQuestion', ASK), resultLine('t1')].join('\n')
    h.notifier.onHookEvent('s-1', notify('m'))
    await flush()
    expect(h.sent).toEqual(['[myproj · work1] 🙋 입력 필요 — m'])
  })

  // 개수 비교는 꼬리 창이 고정이라고 가정한다. 실측에서 transcript는 3.6MB인데 꼬리는 256KB —
  // 파일의 7%만 본다. 세션이 계속 append하면 창이 밀려서 캡처 시점에 창 안에 있던 같은 이름
  // tool_use들이 알림 시점에는 밖으로 나가고, 개수가 늘지 않거나 오히려 줄어 `>` 조건이 성립하지
  // 않는다. 그 결과 이미 끝난 Write가 "대기 중"으로 남아 유휴 알림이 `🙋 입력 필요` + `🔧 Write`로 나갔다.
  it('꼬리 창이 밀려 개수가 줄어도 실행된 호출은 대기 중으로 남지 않는다', async () => {
    let tail = [useLine('t0', 'Write', {}), useLine('t1', 'Write', {}), useLine('t2', 'Write', {})].join('\n')
    const h = setup({ readFileTail: async () => tail })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', pre('Write', { file_path: 'D:\\p\\a.txt' }, 'tX'))
    await flush()
    // 그 호출은 실행돼 기록됐다(id=tX). 그런데 창이 밀려 옛 Write 3건은 빠졌으므로 개수는 줄었다.
    tail = [useLine('tX', 'Write', { file_path: 'D:\\p\\a.txt' }), resultLine('tX')].join('\n')
    h.notifier.onHookEvent('s-1', {
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: 'Claude is waiting for your input',
      transcript_path: 'D:\\t.jsonl'
    })
    await flush()
    expect(h.sent).toEqual([]) // 유휴 + 대기 중 호출 없음 → 아무것도 보내지 않는다
  })

  it('같은 도구의 이전 호출이 이미 있어도 새 캡처를 버리지 않는다 (id 기준의 이유)', async () => {
    // 꼬리에 답변 완료된 이전 질문이 하나 있는 상태에서 새 질문이 뜬다 — "마지막 것이 answered인가"로
    // 판정하면 이 경우 새 질문까지 버려진다. id 기준은 새 캡처의 id(t-new)가 꼬리에 없으므로 남긴다.
    const tail = [useLine('t0', 'AskUserQuestion', ASK), resultLine('t0')].join('\n')
    const h = setup({ readFileTail: async () => tail })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', pre('AskUserQuestion', ASK))
    await flush()
    h.notifier.onHookEvent('s-1', notify('m'))
    await flush()
    expect(h.sent[0]).toContain('❓ 뭐 드실래요?')
  })

  it('Stop이 캐시를 지운다 — readTail 실패로 기준을 못 잡은 캐시까지', async () => {
    const h = setup({ readFileTail: async () => null })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', pre('AskUserQuestion', ASK))
    await flush()
    h.notifier.onHookEvent('s-1', { hook_event_name: 'Stop', transcript_path: 'D:\\t.jsonl' })
    await flush()
    h.notifier.onHookEvent('s-1', notify('m'))
    await flush()
    expect(h.sent.some((t) => t.includes('뭐 드실래요'))).toBe(false)
  })

  it('tool_input이 없으면 로그를 남긴다 — 스키마 변경이 조용히 지나가지 않게', async () => {
    const h = setup({ readFileTail: async () => '' })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', { hook_event_name: 'PreToolUse', tool_name: 'Write' })
    await flush()
    expect(h.logs.some((l) => l.includes('no tool_input'))).toBe(true)
  })

  it('tool_name이 없으면 조용히 무시한다 — 전역 훅 병합으로 쏟아져도 로그가 도배되지 않게', async () => {
    const h = setup({ readFileTail: async () => '' })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', { hook_event_name: 'PreToolUse', tool_input: { a: 1 } })
    await flush()
    expect(h.logs.some((l) => l.includes('PreToolUse'))).toBe(false)
  })

  const post = (id: string, name = 'Write'): Record<string, unknown> => ({
    hook_event_name: 'PostToolUse',
    tool_name: name,
    tool_use_id: id,
    transcript_path: 'D:\\t.jsonl'
  })

  // 재현 실측(현재 Claude Code, PreToolUse/Stop 훅 캡처): 서브에이전트가 실행한 Write의 PreToolUse는
  // **부모의** session_id·transcript_path로 발사되고 agent_id만 덧붙는다. 그런데 그 tool_use_id는
  // 부모 트랜스크립트에 0회, `<session>/subagents/agent-*.jsonl`에만 2회 기록된다. 그래서
  // "꼬리에 id가 보이는가"로는 절대 무효화되지 않고, Stop이 오기 전까지 도착한 모든 알림이
  // `🙋 입력 필요` + `🔧 Write / content: N자`로 나갔다(같은 세션의 메인 Write는 부모 꼬리에 5회
  // 있어 정상 무효화된다 — 서브에이전트 경로 한정 결함이었다).
  it('서브에이전트가 실행한 도구는 부모 꼬리에 id가 없어도 PostToolUse로 무효화된다', async () => {
    const h = setup({ readFileTail: async () => '' }) // 부모 꼬리에는 그 id가 영영 나타나지 않는다
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', {
      ...pre('Write', { file_path: 'D:\\p\\ep104.md', content: '본문' }, 'toolu_sub'),
      agent_id: 'aa4d27f27e1051bbb',
      agent_type: 'general-purpose'
    })
    await flush()
    h.notifier.onHookEvent('s-1', post('toolu_sub'))
    await flush()
    h.notifier.onHookEvent('s-1', notify('Claude needs your permission to use WebFetch'))
    await flush()
    expect(h.sent).toEqual([
      '[myproj · work1] 🙋 입력 필요 — Claude needs your permission to use WebFetch'
    ])
  })

  it('다른 id의 PostToolUse는 캐시를 지우지 않는다 — 병렬 호출 중 하나만 끝난 경우', async () => {
    const h = setup({ readFileTail: async () => '' })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', pre('AskUserQuestion', ASK, 't-wait'))
    await flush()
    h.notifier.onHookEvent('s-1', post('t-other'))
    await flush()
    h.notifier.onHookEvent('s-1', notify('m'))
    await flush()
    expect(h.sent[0]).toContain('뭐 드실래요?')
  })

  it('승인 대기 중에는 PostToolUse가 오지 않으므로 대기 내용이 그대로 실린다 (회귀 가드)', async () => {
    // PostToolUse는 도구가 실제로 실행된 뒤에만 발사된다. 승인 프롬프트가 떠 있는 동안에는 오지
    // 않으므로, 이 수정이 "대기 중인 화면을 알린다"는 본래 기능을 깎지 않는다.
    const h = setup({ readFileTail: async () => '' })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', pre('Write', { file_path: 'D:\\p\\a.txt', content: '본문' }, 't-pending'))
    await flush()
    h.notifier.onHookEvent('s-1', notify('Claude needs your permission'))
    await flush()
    expect(h.sent[0]).toContain('🔧 Write')
    expect(h.sent[0]).toContain('a.txt')
  })

  it('tool_use_id 없는 PostToolUse는 캐시를 건드리지 않는다', async () => {
    const h = setup({ readFileTail: async () => '' })
    h.notifier.register(info())
    h.notifier.onHookEvent('s-1', pre('AskUserQuestion', ASK, 't-wait'))
    await flush()
    h.notifier.onHookEvent('s-1', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' })
    await flush()
    h.notifier.onHookEvent('s-1', notify('m'))
    await flush()
    expect(h.sent[0]).toContain('뭐 드실래요?')
  })
})
