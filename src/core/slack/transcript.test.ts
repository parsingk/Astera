import { describe, it, expect } from 'vitest'
import { extractLastAssistantText } from './transcript'

const line = (obj: unknown): string => JSON.stringify(obj)
const assistant = (text: string): string =>
  line({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const user = (text: string): string => line({ type: 'user', message: { content: text } })

describe('extractLastAssistantText', () => {
  it('마지막 assistant 텍스트를 반환한다', () => {
    const tail = [assistant('첫 응답'), user('질문'), assistant('마지막 응답')].join('\n')
    expect(extractLastAssistantText(tail)).toBe('마지막 응답')
  })

  it('텍스트 없는 assistant 줄(tool_use 전용)·user 줄은 건너뛰고 이전 텍스트를 찾는다', () => {
    const toolOnly = line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } })
    const tail = [assistant('실제 텍스트'), toolOnly, user('후속')].join('\n')
    expect(extractLastAssistantText(tail)).toBe('실제 텍스트')
  })

  it('string content 형태도 지원한다', () => {
    const tail = line({ type: 'assistant', message: { content: '문자열 응답' } })
    expect(extractLastAssistantText(tail)).toBe('문자열 응답')
  })

  it('잘린(불완전 JSON) 줄은 역순 스캔에서 건너뛰고 그 앞의 온전한 assistant를 찾는다', () => {
    // 역순 스캔이 깨진 줄을 먼저 만나 catch로 스킵하는 경로를 강제 (parser.test.ts와 동일 패턴)
    const tail = [assistant('온전한 응답'), '{"type":"assist'].join('\n')
    expect(extractLastAssistantText(tail)).toBe('온전한 응답')
  })

  it('assistant 텍스트가 없으면 null', () => {
    expect(extractLastAssistantText(user('질문만'))).toBeNull()
    expect(extractLastAssistantText('')).toBeNull()
  })
})

// ── 대기 중인 질문 추출 ───────────────────────────────────────
import { extractPendingToolUse, describePendingToolUse, countToolUses } from './transcript'

/** describePendingToolUse는 i18n을 타므로 언어를 고정한다 — 아래 단정들이 ko 문구를 그대로 쓴다. */
const descPending = (use: { name: string; input: unknown }): string =>
  describePendingToolUse(use, 'ko')

/** transcript 한 줄 만들기 헬퍼 */
const asst = (content: unknown[]): string => JSON.stringify({ type: 'assistant', message: { content } })
const usr = (content: unknown[]): string => JSON.stringify({ type: 'user', message: { content } })
const toolUse = (id: string, name: string, input: unknown): unknown => ({ type: 'tool_use', id, name, input })
const toolResult = (id: string): unknown => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })

const ASK = {
  questions: [
    {
      question: '어떤 방식으로 진행할까?',
      header: '진행 방식',
      multiSelect: false,
      options: [
        { label: '지금 고친다', description: '이번 브랜치에서 함께 처리한다' },
        { label: '별도 티켓', description: '따로 떼어 나중에 한다' }
      ]
    }
  ]
}

describe('extractPendingToolUse', () => {
  it('tool_result가 아직 없는 마지막 tool_use를 돌려준다 — 지금 답을 기다리는 것', () => {
    const tail = [asst([toolUse('t1', 'AskUserQuestion', ASK)])].join('\n')
    expect(extractPendingToolUse(tail)).toMatchObject({ id: 't1', name: 'AskUserQuestion' })
  })

  it('tool_result가 붙은 tool_use는 대기 중이 아니다', () => {
    const tail = [asst([toolUse('t1', 'AskUserQuestion', ASK)]), usr([toolResult('t1')])].join('\n')
    expect(extractPendingToolUse(tail)).toBeNull()
  })

  it('여러 tool_use 중 응답이 없는 것만 고른다', () => {
    const tail = [
      asst([toolUse('t1', 'Read', { file_path: 'a.ts' })]),
      usr([toolResult('t1')]),
      asst([toolUse('t2', 'AskUserQuestion', ASK)])
    ].join('\n')
    expect(extractPendingToolUse(tail)).toMatchObject({ id: 't2', name: 'AskUserQuestion' })
  })

  it('여러 개가 대기 중이면 가장 마지막 것 — 화면에 떠 있는 게 그것이다', () => {
    const tail = [
      asst([toolUse('t1', 'Bash', { command: 'ls' })]),
      asst([toolUse('t2', 'AskUserQuestion', ASK)])
    ].join('\n')
    expect(extractPendingToolUse(tail)).toMatchObject({ id: 't2' })
  })

  it('한 assistant 메시지에 tool_use가 여럿이면 그중 응답 없는 것을 찾는다 (병렬 호출)', () => {
    const tail = [
      asst([toolUse('t1', 'Read', {}), toolUse('t2', 'Grep', {})]),
      usr([toolResult('t1')])
    ].join('\n')
    expect(extractPendingToolUse(tail)).toMatchObject({ id: 't2', name: 'Grep' })
  })

  it('tool_use가 없으면 null', () => {
    expect(extractPendingToolUse(asst([{ type: 'text', text: '완료했습니다' }]))).toBeNull()
    expect(extractPendingToolUse('')).toBeNull()
  })

  it('잘린 줄·깨진 JSON은 건너뛴다 — 꼬리를 중간부터 읽으므로 첫 줄이 깨져 있다', () => {
    const tail = ['{"type":"assist', asst([toolUse('t1', 'AskUserQuestion', ASK)])].join('\n')
    expect(extractPendingToolUse(tail)).toMatchObject({ id: 't1' })
  })
})

describe('describePendingToolUse', () => {
  it('AskUserQuestion은 질문과 선택지를 사람이 읽을 형태로 편다', () => {
    const text = descPending({ name: 'AskUserQuestion', input: ASK })
    expect(text).toContain('어떤 방식으로 진행할까?')
    expect(text).toContain('1. 지금 고친다')
    expect(text).toContain('이번 브랜치에서 함께 처리한다')
    expect(text).toContain('2. 별도 티켓')
  })

  it('질문이 여러 개면 모두 담는다', () => {
    const two = {
      questions: [
        { question: '첫째 질문', header: 'A', multiSelect: false, options: [{ label: '가', description: '설명 가' }] },
        { question: '둘째 질문', header: 'B', multiSelect: true, options: [{ label: '나', description: '설명 나' }] }
      ]
    }
    const text = descPending({ name: 'AskUserQuestion', input: two })
    expect(text).toContain('첫째 질문')
    expect(text).toContain('둘째 질문')
  })

  it('여러 개 선택 가능하면 그 사실을 알린다 — 폰에서 답할 때 필요한 정보다', () => {
    const multi = {
      questions: [
        { question: '무엇을 켤까?', header: 'X', multiSelect: true, options: [{ label: 'a', description: 'd' }] }
      ]
    }
    expect(descPending({ name: 'AskUserQuestion', input: multi })).toContain('여러 개')
  })

  it('AskUserQuestion이 아닌 도구는 무엇을 승인해야 하는지 이름과 인자로 알린다', () => {
    const text = descPending({ name: 'Bash', input: { command: 'rm -rf build/' } })
    expect(text).toContain('Bash')
    expect(text).toContain('rm -rf build/')
  })

  // 종전에는 키당 400자에서 잘랐다("도배 방지"). 사용자가 잘린 내용을 다 보고 싶다고 해서 Slack
  // 한계까지 열었다 — 도배 위험은 남고, 최종 방어는 slack.ts send()의 절단이다.
  it('인자가 종전 상한(400자)을 넘어도 온전히 나간다', () => {
    const text = descPending({ name: 'Grep', input: { pattern: 'x'.repeat(2000) } })
    expect(text).toContain('x'.repeat(2000))
    expect(text).not.toContain('…')
  })

  it('구조가 예상과 다르면 도구 이름만이라도 알린다', () => {
    expect(descPending({ name: 'Weird', input: null })).toContain('Weird')
  })

  // ── 민감 인자 요약 ─────────────────────────────────────────────────────
  it('Write의 content는 값 대신 글자 수로 요약한다 — 승인 판단엔 file_path로 충분하고 파일 본문이 그대로 새 나갈 위험이 크다', () => {
    const text = descPending({
      name: 'Write',
      input: { file_path: 'a.ts', content: 'x'.repeat(2000) }
    })
    expect(text).toContain('file_path: a.ts')
    expect(text).toContain('content: 2000자')
    expect(text).not.toContain('x'.repeat(50))
  })

  it('Edit의 old_string/new_string도 값 대신 글자 수로 요약한다', () => {
    const text = descPending({
      name: 'Edit',
      input: { old_string: 'secret'.repeat(10), new_string: 'other'.repeat(10) }
    })
    expect(text).toContain('old_string: 60자')
    expect(text).toContain('new_string: 50자')
    expect(text).not.toContain('secretsecret')
  })

  it('Bash의 command는 값을 그대로 유지한다 — 무엇을 실행하는지가 승인 판단의 핵심이라 감출 수 없다', () => {
    const text = descPending({ name: 'Bash', input: { command: 'npm run build' } })
    expect(text).toContain('command: npm run build')
  })

  // COMMAND_MAX도 Slack 한계로 열렸다. 종전에는 200자에서 잘라 명령 뒷부분이 사라졌고, 그것이
  // "무엇을 승인하는지" 판단을 방해했다.
  it('Bash의 command가 종전 상한(200자)을 넘어도 온전히 나간다', () => {
    const text = descPending({ name: 'Bash', input: { command: 'x'.repeat(500) } })
    expect(text).toContain('x'.repeat(500))
    expect(text).not.toContain('…')
  })

  // ── AskUserQuestion 스키마 불일치 폴백 ────────────────────────────────
  it('questions가 없으면 일반 인자 덤프로 떨어져 실제 input을 보여준다 — 정보가 0이 되지 않는다', () => {
    const text = descPending({
      name: 'AskUserQuestion',
      input: { prompt: '다른 스키마로 바뀐 인자' }
    })
    expect(text).toContain('AskUserQuestion')
    expect(text).toContain('prompt')
    expect(text).toContain('다른 스키마로 바뀐 인자')
  })

  it('questions가 빈 배열이어도 일반 인자 덤프로 떨어진다', () => {
    const text = descPending({
      name: 'AskUserQuestion',
      input: { questions: [], reason: '빈 배열' }
    })
    expect(text).toContain('reason')
    expect(text).toContain('빈 배열')
  })

  it('input이 빈 객체면 도구 이름만 남는다 — 그 이상 보여줄 게 없다', () => {
    expect(descPending({ name: 'AskUserQuestion', input: {} })).toBe('🔧 AskUserQuestion')
  })

  // ── 개별 상한 (Slack 한계로 확대) ──────────────────────────────────────
  // 종전에는 question 200자·label 80자에서 잘랐다. 사용자 요청으로 상한을 Slack `text` 한계까지
  // 열었으므로 그 길이에서는 더 자르지 않는다 — 잘림 자체는 아래 "Slack 한계를 넘으면" 테스트가 지킨다.
  it('question 문구가 종전 상한(200자)을 넘어도 자르지 않는다', () => {
    const q = {
      questions: [{ question: 'q'.repeat(500), multiSelect: false, options: [{ label: 'a', description: '' }] }]
    }
    const text = descPending({ name: 'AskUserQuestion', input: q })
    expect(text).toContain('q'.repeat(500))
    expect(text).not.toContain('…')
  })

  it('선택지 label이 종전 상한(80자)을 넘어도 자르지 않는다', () => {
    const q = {
      questions: [{ question: '질문', multiSelect: false, options: [{ label: 'L'.repeat(300), description: '' }] }]
    }
    const text = descPending({ name: 'AskUserQuestion', input: q })
    expect(text).toContain('L'.repeat(300))
    expect(text).not.toContain('…')
  })

  it('Slack 한계를 넘으면 총량 상한에서 자른다 — 절단이 사라진 것은 아니다', () => {
    const input = { note: 'z'.repeat(40_100) } // SLACK_TEXT_MAX(40,000) 초과
    const text = descPending({ name: 'Weird', input })
    expect(text.length).toBeLessThanOrEqual(40_001) // TOTAL_MAX + '…'
    expect(text).toContain('…')
  })

  // ── 총량 상한 (Slack 한계로 확대) ─────────────────────────────────────
  it('키가 많아도 Slack 한계 안이면 자르지 않는다 — 종전 총량 상한(1200)에서 잘렸던 경우', () => {
    // 키 20개 × 390자 = 약 8,000자. 종전 TOTAL_MAX(1200)이면 여기서 잘렸다.
    const input = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`key${i}`, 'y'.repeat(390)]))
    const text = descPending({ name: 'Weird', input })
    expect(text.length).toBeGreaterThan(1201)
    expect(text).not.toContain('…')
  })

  it('질문 3개 × 옵션 3개(캡 없이 1,969자)도 이제 온전히 나간다 — 안내는 여전히 캡 밖', () => {
    const bigQuestions = {
      questions: Array.from({ length: 3 }, (_, qi) => ({
        question: `질문 ${qi}은 무엇을 할지 정하는 것이다`,
        multiSelect: false,
        options: Array.from({ length: 3 }, (_, oi) => ({
          label: `옵션 ${oi}`,
          description: 'd'.repeat(200)
        }))
      }))
    }
    const text = descPending({ name: 'AskUserQuestion', input: bigQuestions })
    // 답장 형식 안내는 총량 캡 **밖에서** 붙는다 (replyHint 주석) — 잘려 사라지면
    // 형식을 모른 채 답장하게 되므로 본문보다 먼저 지킨다. 그 구조는 상한을 열어도 그대로다.
    const hint = '💡 질문마다 `/`로 구분해 답장 (예: 1,3 / 2)'
    expect(text.endsWith(`\n${hint}`)).toBe(true)
    const body = text.slice(0, -(hint.length + 1))
    expect(body.length).toBeGreaterThan(1201) // 종전 총량 상한(1200)이면 여기서 잘렸다
    expect(body).not.toContain('…')
  })

  it('질문 하나 + 단일 선택이면 안내를 붙이지 않는다 — 번호만 보내면 되는 경우', () => {
    const one = {
      questions: [{ question: '뭐로 할까?', multiSelect: false, options: [{ label: 'a' }, { label: 'b' }] }]
    }
    expect(descPending({ name: 'AskUserQuestion', input: one })).not.toContain('💡')
  })

  it('질문 하나 + 다중 선택이면 쉼표 형식을 알린다 (질문 문구와 겹치지 않는 자리)', () => {
    const one = {
      questions: [
        { question: '뭐 드실래요? (여러 개 선택 가능)', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] }
      ]
    }
    const text = descPending({ name: 'AskUserQuestion', input: one })
    // 종전에는 질문 뒤에 ' (여러 개 선택 가능)'을 덧붙여 모델 문구와 겹쳤다
    expect(text.match(/\(여러 개 선택 가능\)/g)).toHaveLength(1)
    expect(text).toContain('💡 여러 개는 쉼표로 구분해 답장 (예: 1,3)')
  })
})

describe('countToolUses', () => {
  it('같은 이름의 tool_use만 센다 — 응답 여부와 무관하게', () => {
    const tail = [
      asst([toolUse('t1', 'Write', { file_path: 'a.ts' })]),
      usr([toolResult('t1')]),
      asst([toolUse('t2', 'Bash', { command: 'ls' })]),
      asst([toolUse('t3', 'Write', { file_path: 'b.ts' })])
    ].join('\n')
    expect(countToolUses(tail, 'Write')).toBe(2)
    expect(countToolUses(tail, 'Bash')).toBe(1)
    expect(countToolUses(tail, 'AskUserQuestion')).toBe(0)
  })

  it('빈 꼬리와 깨진 줄은 0으로 센다 — 중간부터 읽은 꼬리에 깨진 줄이 섞인다', () => {
    expect(countToolUses('', 'Write')).toBe(0)
    expect(countToolUses('{"type":"assis', 'Write')).toBe(0)
    // 깨진 첫 줄 뒤의 온전한 줄은 정상적으로 센다
    expect(countToolUses(`{"broken\n${asst([toolUse('t1', 'Write', {})])}`, 'Write')).toBe(1)
  })

  it('한 assistant 줄에 병렬로 담긴 tool_use를 각각 센다', () => {
    const tail = asst([toolUse('t1', 'Read', {}), toolUse('t2', 'Read', {})])
    expect(countToolUses(tail, 'Read')).toBe(2)
  })
})
