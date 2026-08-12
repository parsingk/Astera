import { describe, it, expect } from 'vitest'
import { t } from '../i18n'
import {
  classifyInbound,
  toSessionInput,
  buildChoiceKeys,
  MAX_INJECT_CHARS,
  type InboundMessage,
  type ChoiceShape
} from './inbound'

const CH = 'C-target'
const ME = 'U-owner' // 허용된 Member ID — Slack은 메시지 이벤트의 user 필드로 보낸다
const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  channel: CH,
  text: '이어서 진행해',
  thread_ts: '1700000000.000100',
  ts: '1700000500.000200',
  user: ME,
  ...over
})

describe('classifyInbound', () => {
  it('설정된 채널의 스레드 답장은 주입 대상이다', () => {
    expect(classifyInbound(msg(), CH, ME)).toEqual({
      kind: 'inject',
      threadTs: '1700000000.000100',
      text: '이어서 진행해'
    })
  })

  it('봇 자신의 메시지는 무시한다 — 안 걸면 알림→수신→주입 무한 루프가 난다', () => {
    expect(classifyInbound(msg({ bot_id: 'B123' }), CH, ME)).toEqual({
      kind: 'ignore',
      reason: 'bot-message'
    })
  })

  it('봇 판정이 다른 조건보다 먼저다 — 다른 채널이면서 봇인 것도 봇으로 끊긴다', () => {
    // 순서가 뒤바뀌어도 결과적으로 무시되긴 하지만, 루프 차단이 가장 먼저여야 한다는 의도를 고정한다
    expect(classifyInbound(msg({ bot_id: 'B1', channel: 'C-other' }), CH, ME).kind).toBe('ignore')
    expect(
      (classifyInbound(msg({ bot_id: 'B1', channel: 'C-other' }), CH, ME) as { reason: string })
        .reason
    ).toBe('bot-message')
  })

  it('설정된 채널이 아니면 무시한다 — 봇이 다른 채널에도 초대돼 있을 수 있다', () => {
    expect(classifyInbound(msg({ channel: 'C-other' }), CH, ME)).toEqual({
      kind: 'ignore',
      reason: 'other-channel'
    })
  })

  it('thread_ts가 없으면(채널에 바로 쓴 글) 무시한다', () => {
    expect(classifyInbound(msg({ thread_ts: undefined }), CH, ME)).toEqual({
      kind: 'ignore',
      reason: 'not-thread-reply'
    })
  })

  it('thread_ts가 ts와 같으면 스레드 루트 자체이므로 무시한다', () => {
    expect(
      classifyInbound(msg({ thread_ts: '1700000000.000100', ts: '1700000000.000100' }), CH, ME)
    ).toEqual({
      kind: 'ignore',
      reason: 'not-thread-reply'
    })
  })

  it('편집·삭제 등 subtype이 붙은 이벤트는 무시한다 — 방금 친 말이 아니다', () => {
    expect(classifyInbound(msg({ subtype: 'message_changed' }), CH, ME)).toEqual({
      kind: 'ignore',
      reason: 'subtype'
    })
  })

  it('file_share subtype(스크린샷 등 파일 첨부 답장)은 허용한다', () => {
    expect(classifyInbound(msg({ subtype: 'file_share' }), CH, ME)).toEqual({
      kind: 'inject',
      threadTs: '1700000000.000100',
      text: '이어서 진행해'
    })
  })

  it('thread_broadcast subtype("채널에도 전송")은 허용한다', () => {
    expect(classifyInbound(msg({ subtype: 'thread_broadcast' }), CH, ME)).toEqual({
      kind: 'inject',
      threadTs: '1700000000.000100',
      text: '이어서 진행해'
    })
  })

  it('빈 텍스트·공백만 있는 답장은 무시한다', () => {
    expect(classifyInbound(msg({ text: '   ' }), CH, ME)).toEqual({
      kind: 'ignore',
      reason: 'empty-text'
    })
    expect(classifyInbound(msg({ text: undefined }), CH, ME)).toEqual({
      kind: 'ignore',
      reason: 'empty-text'
    })
  })

  it('앞뒤 공백은 잘라낸다', () => {
    const d = classifyInbound(msg({ text: '  진행해  ' }), CH, ME)
    expect(d).toMatchObject({ kind: 'inject', text: '진행해' })
  })

  it('MAX_INJECT_CHARS를 넘는 답장은 거부한다 — 잘라서 보내지 않는다 (부분 명령이 더 위험)', () => {
    const long = 'x'.repeat(MAX_INJECT_CHARS + 1)
    expect(classifyInbound(msg({ text: long }), CH, ME)).toEqual({
      kind: 'ignore',
      reason: 'too-long',
      threadTs: '1700000000.000100'
    })
  })

  it('MAX_INJECT_CHARS 이하는 그대로 주입된다', () => {
    const atLimit = 'x'.repeat(MAX_INJECT_CHARS)
    expect(classifyInbound(msg({ text: atLimit }), CH, ME)).toMatchObject({
      kind: 'inject',
      text: atLimit
    })
  })

  it('HTML 엔티티(&amp;·&lt;·&gt;)를 되돌린다', () => {
    expect(classifyInbound(msg({ text: 'npm run build &amp;&amp; npm test' }), CH, ME)).toMatchObject({
      text: 'npm run build && npm test'
    })
    expect(classifyInbound(msg({ text: 'x &lt;y&gt; z' }), CH, ME)).toMatchObject({ text: 'x <y> z' })
  })

  it('&amp;를 마지막에 풀어야 한다 — 먼저 풀면 &amp;lt;가 <로 잘못 디코딩된다', () => {
    // 사용자가 글자 그대로 "&lt;"를 쳤다면 Slack은 그 '&'만 이스케이프해 "&amp;lt;"로 보낸다.
    // amp를 먼저 풀면 "&lt;"가 생겨 뒤이어 <로 이중 디코딩되지만, amp를 마지막에 풀면 "&lt;" 그대로 남는다.
    expect(classifyInbound(msg({ text: '&amp;lt;' }), CH, ME)).toMatchObject({ text: '&lt;' })
  })

  it('링크 문법을 사람이 읽는 텍스트로 편다', () => {
    expect(classifyInbound(msg({ text: '<https://example.com|문서 보기>' }), CH, ME)).toMatchObject({
      text: '문서 보기'
    })
    expect(classifyInbound(msg({ text: '<https://example.com>' }), CH, ME)).toMatchObject({
      text: 'https://example.com'
    })
  })

  it('멘션도 같은 <…> 문법으로 풀린다', () => {
    expect(classifyInbound(msg({ text: '<@U123> 확인해줘' }), CH, ME)).toMatchObject({
      text: '@U123 확인해줘'
    })
    expect(classifyInbound(msg({ text: '<#C123|general> 참고' }), CH, ME)).toMatchObject({
      text: 'general 참고'
    })
  })
})

describe('classifyInbound — Member ID 제한', () => {
  it('허용된 Member ID가 아닌 사람의 답장은 주입하지 않는다', () => {
    expect(classifyInbound(msg({ user: 'U-stranger' }), CH, ME)).toEqual({
      kind: 'ignore',
      reason: 'not-allowed-user'
    })
  })

  it('Member ID가 설정되지 않았으면 전부 차단한다 — 미설정을 전원 허용으로 흘리지 않는다', () => {
    expect(classifyInbound(msg(), CH, null)).toEqual({
      kind: 'ignore',
      reason: 'member-id-unset'
    })
    // 공백만 채운 설정도 미설정과 같다
    expect(classifyInbound(msg(), CH, '   ')).toEqual({
      kind: 'ignore',
      reason: 'member-id-unset'
    })
  })

  it('미설정과 불일치를 다른 reason으로 구별한다 — 로그만 보고 원인을 가릴 수 있어야 한다', () => {
    const unset = classifyInbound(msg(), CH, null) as { reason: string }
    const mismatch = classifyInbound(msg({ user: 'U-stranger' }), CH, ME) as { reason: string }
    expect(unset.reason).not.toBe(mismatch.reason)
  })

  it('user 필드가 없는 이벤트도 차단한다 — 보낸 사람을 알 수 없으면 통과시키지 않는다', () => {
    expect(classifyInbound(msg({ user: undefined }), CH, ME)).toEqual({
      kind: 'ignore',
      reason: 'not-allowed-user'
    })
    expect(classifyInbound(msg({ user: 123 }), CH, ME)).toEqual({
      kind: 'ignore',
      reason: 'not-allowed-user'
    })
  })

  it('설정값과 user 양쪽의 앞뒤 공백은 비교 전에 잘라낸다', () => {
    expect(classifyInbound(msg({ user: `  ${ME}  ` }), CH, `  ${ME}  `)).toMatchObject({
      kind: 'inject'
    })
  })

  it('대소문자는 정규화하지 않는다 — Slack ID는 항상 대문자이고 오타는 로그로 진단한다', () => {
    expect(classifyInbound(msg({ user: ME.toLowerCase() }), CH, ME)).toEqual({
      kind: 'ignore',
      reason: 'not-allowed-user'
    })
  })

  it('봇·채널 판정이 user 판정보다 먼저다 — 루프 차단과 채널 경계가 앞선다', () => {
    expect(classifyInbound(msg({ user: 'U-stranger', bot_id: 'B1' }), CH, ME)).toEqual({
      kind: 'ignore',
      reason: 'bot-message'
    })
    expect(classifyInbound(msg({ user: 'U-stranger', channel: 'C-other' }), CH, ME)).toEqual({
      kind: 'ignore',
      reason: 'other-channel'
    })
  })

  it('subtype 판정이 user 판정보다 먼저다 — 편집 이벤트는 최상위 user가 없어 오분류된다', () => {
    // message_changed는 작성자를 message.user에 담아 보내므로 최상위 user가 비어 있다.
    // user 검사를 subtype보다 앞에 두면 이 이벤트가 not-allowed-user로 기록되어 기존 로그 의미가 깨진다.
    expect(classifyInbound(msg({ subtype: 'message_changed', user: undefined }), CH, ME)).toEqual({
      kind: 'ignore',
      reason: 'subtype'
    })
  })

  it('허용되지 않은 사람의 긴 답장에는 스레드 노트를 남기지 않는다 — 외부인에게 봇이 반응하면 안 된다', () => {
    // too-long은 ignore 중 유일하게 스레드에 노트를 남기는 경로다. user 판정이 그 앞에 있어야
    // 외부인이 4,000자 넘는 글로 봇을 움직일 수 없다 — threadTs가 없으면 호출부가 노트를 남기지 않는다.
    const d = classifyInbound(
      msg({ user: 'U-stranger', text: 'x'.repeat(MAX_INJECT_CHARS + 1) }),
      CH,
      ME
    )
    expect(d).toEqual({ kind: 'ignore', reason: 'not-allowed-user' })
    expect(d).not.toHaveProperty('threadTs')
  })

  it('스레드 답장이 아닌 것보다 user 판정이 먼저다 — 외부인의 채널 글은 보낸 사람으로 끊긴다', () => {
    expect(classifyInbound(msg({ user: 'U-stranger', thread_ts: undefined }), CH, ME)).toEqual({
      kind: 'ignore',
      reason: 'not-allowed-user'
    })
  })
})

describe('toSessionInput', () => {
  it('한 줄은 텍스트만 돌려주고 제출 플래그를 켠다 — Enter는 SlackInbox가 지연 후 별도로 보낸다', () => {
    expect(toSessionInput('계속')).toEqual({ text: '계속', submit: true })
  })

  it('여러 줄은 Alt+Enter(ESC+CR)로 개행한다 — text에 마지막 Enter는 포함하지 않는다', () => {
    // 개행을 그대로 보내면 줄마다 제출로 받아 여러 턴이 시작된다
    expect(toSessionInput('첫 줄\n두 번째 줄')).toEqual({ text: '첫 줄\x1b\r두 번째 줄', submit: true })
  })

  it('CRLF·CR 단독도 같은 방식으로 접는다', () => {
    expect(toSessionInput('a\r\nb')).toEqual({ text: 'a\x1b\rb', submit: true })
    expect(toSessionInput('a\rb')).toEqual({ text: 'a\x1b\rb', submit: true })
  })

  it('개행 세 개 이상도 각각 변환된다', () => {
    expect(toSessionInput('a\nb\nc')).toEqual({ text: 'a\x1b\rb\x1b\rc', submit: true })
  })

  it('C0 제어문자·DEL은 제거한다 — 개행(\\n·\\r)만 예외다', () => {
    expect(toSessionInput('a\x03\x04b')).toEqual({ text: 'ab', submit: true }) // Ctrl+C(턴 중단)·Ctrl+D(종료)
    expect(toSessionInput('\x1b[31mred\x1b[0m')).toEqual({ text: '[31mred[0m', submit: true }) // ESC 제거로 ANSI 무력화
    expect(toSessionInput('탭\t구분')).toEqual({ text: '탭구분', submit: true }) // 탭(0x09)도 C0이라 제거된다
    expect(toSessionInput('줄1\n줄2')).toEqual({ text: '줄1\x1b\r줄2', submit: true }) // 의도한 개행은 남는다
  })
})

describe('buildChoiceKeys', () => {
  const multi = (n: number): ChoiceShape => ({ multiSelect: true, optionCount: n })
  const single = (n: number): ChoiceShape => ({ multiSelect: false, optionCount: n })
  // 실패 사유는 Message라 여기서 ko로 번역해 문구까지 함께 검증한다 — 템플릿의 자리표시자가
  // 빠지면 아래 단정이 잡는다.
  const keys = (text: string, shape: ChoiceShape[]): string[] | string => {
    const r = buildChoiceKeys(text, shape)
    return r.ok ? r.keys : t('ko', r.reason.key, r.reason.params)
  }

  it('다중 선택은 번호를 토글한 뒤 Tab으로 Submit 탭까지 옮기고 Enter로 제출한다', () => {
    // 숫자는 포커스를 옮기지 않고 토글만 한다 — 그래서 Tab이 따로 필요하다 (buildChoiceKeys 주석)
    expect(keys('1,3', [multi(3)])).toEqual(['1', '3', '\t', '\r'])
    expect(keys('2', [multi(3)])).toEqual(['2', '\t', '\r'])
    expect(keys(' 1 , 2 ', [multi(3)])).toEqual(['1', '2', '\t', '\r']) // 공백은 무시
  })

  it('단일 선택에는 Tab을 넣지 않는다 — 답하면 shouldAdvance로 저절로 전진한다', () => {
    expect(keys('2', [single(4)])).toEqual(['2', '\r'])
  })

  it('여러 질문은 슬래시로 나누고, 질문마다 모드에 맞는 전진을 붙인다', () => {
    expect(keys('1,3 / 2', [multi(3), single(2)])).toEqual(['1', '3', '\t', '2', '\r'])
    expect(keys('1 / 2 / 1', [single(2), single(2), single(2)])).toEqual(['1', '2', '1', '\r'])
    expect(keys('1 / 2', [multi(2), multi(2)])).toEqual(['1', '\t', '2', '\t', '\r'])
  })

  it('형식이 어긋나면 아무 키도 만들지 않고 이유를 돌려준다 — 잘못 누른 시퀀스는 되돌릴 수 없다', () => {
    expect(keys('1', [multi(3), single(2)])).toContain('/') // 답이 질문 수보다 적다 → 형식 안내
    expect(keys('1 / 2 / 3', [multi(3)])).toContain('/')
    expect(keys('4', [multi(3)])).toContain('없습니다') // 범위 밖
    expect(keys('0', [multi(3)])).toContain('없습니다')
    expect(keys('12', [multi(3)])).toContain('없습니다') // 두 글자는 키 하나로 못 보낸다
    expect(keys('1,2', [single(3)])).toContain('하나만') // 단일 선택에 여러 번호
    expect(keys('없음', [multi(3)])).toContain('번호')
    expect(keys('1', [])).toContain('찾지 못했습니다') // 모양 정보 없음
  })
})
