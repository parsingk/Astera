import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ClaudeTranscriptTail } from './claudeSignal'

// 소스에 통짜 트리거를 두지 않으려는 분할
const LIMIT_TEXT = "You've hit your " + 'weekly limit · resets 7pm (Asia/Seoul)'
const SINCE = Date.parse('2026-08-03T06:00:00.000Z')
const AFTER = '2026-08-03T06:50:57.017Z' // SINCE 이후
const BEFORE = '2026-08-03T05:00:00.000Z' // SINCE 이전

/** 메인 루프 한도 항목 — error 필드로 구조화돼 있다 */
const mainHit = (ts = AFTER, text = LIMIT_TEXT): string =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] },
    error: 'rate_limit',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    timestamp: ts
  })

/** 서브에이전트 한도 항목 — error 필드가 없어 문구로만 가린다 */
const subHit = (ts = AFTER, cause = LIMIT_TEXT): string =>
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', is_error: true, content: `Agent terminated early due to an API error: ${cause}` }
      ]
    },
    timestamp: ts
  })

/** 봉투 없는 tool_result — 실측 오탐 5건의 축소판 재현용 */
const bareSubHit = (ts: string, content: string): string =>
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', is_error: true, content }] },
    timestamp: ts
  })

describe('ClaudeTranscriptTail', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-cs-'))
    file = path.join(dir, 'transcript.jsonl')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  const write = async (...lines: string[]): Promise<void> => {
    await fs.writeFile(file, lines.join('\n') + '\n', 'utf8')
  }
  const append = async (...lines: string[]): Promise<void> => {
    await fs.appendFile(file, lines.join('\n') + '\n', 'utf8')
  }

  // 아래 테스트들은 tail을 먼저 만들고 그 다음에 파일을 쓴다(실제 순서와 동일 — applyMeta가
  // ClaudeTranscriptTail을 만든 시점 이후에야 transcript에 새 줄이 쌓인다). 순서를 반대로 하면
  // (write 먼저) JsonlTail의 startAtEnd가 생성 시점 이전 내용으로 보고
  // 건너뛰어 버려서, 아래 판정 로직(error 필드·envelope·since 비교)이 전혀 실행되지 않고도
  // "히트 없음"이 우연히 통과해 버린다 — 테스트가 자신이 검증하려는 로직을 더 이상 타지 않게 된다.

  it('메인 루프 한도 항목을 잡는다', async () => {
    const tail = new ClaudeTranscriptTail(file, SINCE)
    await write(mainHit())
    const hit = await tail.read()
    expect(hit?.source).toBe('main')
    expect(hit?.at).toBe(Date.parse(AFTER))
    expect(hit?.text).toContain('weekly limit')
  })

  it('서브에이전트 한도 항목을 잡는다', async () => {
    const tail = new ClaudeTranscriptTail(file, SINCE)
    await write(subHit())
    const hit = await tail.read()
    expect(hit?.source).toBe('subagent')
  })

  it('server_error는 한도가 아니다', async () => {
    for (const status of [500, 529]) {
      await fs.rm(file, { force: true }) // 이전 반복의 내용을 지워 startAtEnd 오프셋이 새로 잡히게 한다
      const tail = new ClaudeTranscriptTail(file, SINCE)
      await write(
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Overloaded' }] },
          error: 'server_error',
          isApiErrorMessage: true,
          apiErrorStatus: status,
          timestamp: AFTER
        })
      )
      expect(await tail.read()).toBeNull()
    }
  })

  it('error 필드가 없는 assistant 항목은 무시한다', async () => {
    const tail = new ClaudeTranscriptTail(file, SINCE)
    await write(
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: LIMIT_TEXT }] },
        timestamp: AFTER
      })
    )
    expect(await tail.read()).toBeNull()
  })

  // 서브에이전트는 한도 외 오류가 섞여 온다
  it.each([
    "API Error: Claude's response exceeded the 64000 output token maximum",
    'API Error: 529 Overloaded. This is a server-side issue',
    'API Error: Stream idle timeout - no chunks received'
  ])('서브에이전트의 한도 아닌 오류는 무시한다: %s', async (cause) => {
    const tail = new ClaudeTranscriptTail(file, SINCE)
    await write(subHit(AFTER, cause))
    expect(await tail.read()).toBeNull()
  })

  // 리뷰가 4,706개 실측 전사에 병합 판정을 돌려 찾은 서브에이전트 오탐 9건 중 5건 — 전부 API 에러
  // 봉투(Agent terminated early due to an API error:) 없이 문구만 우연히 섞인 평범한 도구 실패다.
  // 실제 파일명·정규식 소스를 그대로 옮기지 않고 형태만 재현한다(이 파일 자체가 트리거가 되지
  // 않도록). LIMIT_TEXT는 이미 접합으로 분할돼 있으므로 재사용해도 통짜 리터럴이 생기지 않는다.
  it.each([
    ['Edit 실패가 되읊은 old_string 인용문', 'String to replace not found in file. old_string was: "' + LIMIT_TEXT + '"'],
    ['node -e SyntaxError가 되읊은 정규식 소스 문맥', 'SyntaxError: Invalid regular expression near: ' + LIMIT_TEXT],
    ['다른 파일에 대한 Edit 실패', 'String to replace not found in file: detect.test.ts\nold_string: "' + LIMIT_TEXT + '"'],
    [
      'vitest 실행 실패가 출력한 테스트 제목(런타임 보간)',
      'FAIL src/core/rolling/detect.test.ts\n  ✗ ' + LIMIT_TEXT + ' 문구를 감지한다'
    ],
    [
      '같은 vitest 실행의 재현(TDD 루프)',
      'FAIL src/core/rolling/detect.test.ts (2)\n  ✗ ' + LIMIT_TEXT + ' 문구를 감지한다'
    ]
  ])('봉투 없는 서브에이전트 tool_result는 문구가 있어도 무시한다 — %s', async (_label, content) => {
    const tail = new ClaudeTranscriptTail(file, SINCE)
    await write(bareSubHit(AFTER, content))
    expect(await tail.read()).toBeNull()
  })

  it('한도 문구 앞에 공백이 있어도 API 에러 봉투로 인정한다', async () => {
    const tail = new ClaudeTranscriptTail(file, SINCE)
    await write(bareSubHit(AFTER, '\n  Agent terminated early due to an API error: ' + LIMIT_TEXT))
    const hit = await tail.read()
    expect(hit?.source).toBe('subagent')
  })

  it('toolUseResult 변형의 Error: 접두가 붙어도 봉투로 인정한다', async () => {
    const tail = new ClaudeTranscriptTail(file, SINCE)
    await write(bareSubHit(AFTER, 'Error: Agent terminated early due to an API error: ' + LIMIT_TEXT))
    const hit = await tail.read()
    expect(hit?.source).toBe('subagent')
  })

  it('is_error가 false면 한도 문구가 있어도 무시한다 — 도구 출력에 인용된 경우', async () => {
    const tail = new ClaudeTranscriptTail(file, SINCE)
    await write(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', is_error: false, content: LIMIT_TEXT }] },
        timestamp: AFTER
      })
    )
    expect(await tail.read()).toBeNull()
  })

  // 아래 since 경계 테스트 두 건은 construct 전에 파일에 쓰지 않는다 — startAtEnd 때문에 그러면
  // since 비교 코드에 도달하기 전에 위치 기준으로 건너뛰어져 버려 이 비교 로직 자체가 실행되지
  // 않는다(실제로는 무해하다 — construct 시점 이전 내용은 since로도 걸렸을 내용이다, §5). 여기서는
  // construct 뒤에 파일을 만들어 since 비교가 실제로 그 값을 보고 배제하는지를 직접 확인한다.
  it('since 이전 항목은 무시한다 — 롤 복사본의 옛 에러를 재감지하지 않는다', async () => {
    const tail = new ClaudeTranscriptTail(file, SINCE)
    await write(mainHit(BEFORE))
    expect(await tail.read()).toBeNull()
  })

  it('since와 같은 시각도 무시한다 (경계는 배제 쪽)', async () => {
    const tail = new ClaudeTranscriptTail(file, SINCE)
    await write(mainHit(new Date(SINCE).toISOString()))
    expect(await tail.read()).toBeNull()
  })

  it('timestamp가 없거나 파싱 불가면 무시한다', async () => {
    const tail = new ClaudeTranscriptTail(file, SINCE)
    await write(
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [] },
        error: 'rate_limit',
        apiErrorStatus: 429
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [] },
        error: 'rate_limit',
        apiErrorStatus: 429,
        timestamp: 'not-a-date'
      })
    )
    expect(await tail.read()).toBeNull()
  })

  it('여러 hit가 한 번에 들어오면 가장 늦은 것', async () => {
    const tail = new ClaudeTranscriptTail(file, SINCE)
    const mid = '2026-08-03T06:30:00.000Z'
    await write(mainHit(mid), subHit(AFTER))
    const hit = await tail.read()
    expect(hit?.at).toBe(Date.parse(AFTER))
    expect(hit?.source).toBe('subagent')
  })

  it('이미 읽은 항목은 다시 돌려주지 않는다 (증분)', async () => {
    const tail = new ClaudeTranscriptTail(file, SINCE)
    await write(mainHit())
    expect((await tail.read())?.source).toBe('main')
    expect(await tail.read()).toBeNull()
  })

  it('새로 덧붙은 항목만 잡는다', async () => {
    // 여기서는 write가 construct보다 먼저다 — 의도적이다: 이 mainHit()은 "생성 시점에 이미 있던
    // 내용"을 대표하고, 그 내용이 스킵되는지가 아니라 그 뒤(append)에 온 것만 잡히는지를 본다.
    await write(mainHit())
    const tail = new ClaudeTranscriptTail(file, SINCE)
    await tail.read()
    const later = '2026-08-03T07:00:00.000Z'
    await append(subHit(later))
    const hit = await tail.read()
    expect(hit?.at).toBe(Date.parse(later))
  })

  it('파일이 재생성돼도 since 필터가 옛 항목을 막는다', async () => {
    // 여기도 write가 construct보다 먼저다 — 이 3줄은 "생성 시점 내용"으로 스킵되고, 아래 재생성
    // (파일이 짧아짐)이 JsonlTail의 restarted 경로를 타면서 오프셋이 0으로 리셋되는 게 핵심이다 —
    // 그 순간 since 필터가 재생성된 파일의 옛 항목을 실제로 걸러내는지를 본다.
    await write(mainHit(), mainHit(), mainHit())
    const tail = new ClaudeTranscriptTail(file, SINCE)
    await tail.read()
    // 파일이 짧아지면 JsonlTail이 restarted로 보고 처음부터 다시 읽는다 —
    // 그때 옛 항목이 다시 보이지만 since가 걸러야 한다
    await write(mainHit(BEFORE))
    expect(await tail.read()).toBeNull()
  })

  it('파일이 없으면 null (크래시 금지)', async () => {
    expect(await new ClaudeTranscriptTail(path.join(dir, 'nope.jsonl'), SINCE).read()).toBeNull()
  })

  // readFailed: read()의 반환값(null)만으로는 "히트 없음"과 "읽기 자체가
  // 실패함"을 구분할 수 없다 — 학습된 경로가 틀렸거나 접근 권한이 사라지면 후자인데, 판정 로직은
  // 둘 다 동일하게 무시해야 맞지만 로그를 남기려는 호출자는 구분이 필요하다.
  it('파일이 없으면 readFailed=true — 히트 없음과 읽기 실패를 구분한다', async () => {
    const tail = new ClaudeTranscriptTail(path.join(dir, 'nope.jsonl'), SINCE)
    expect(await tail.read()).toBeNull()
    expect(tail.readFailed).toBe(true)
  })

  it('파일은 있지만 히트가 없으면 readFailed=false', async () => {
    const tail = new ClaudeTranscriptTail(file, SINCE)
    await write(mainHit(BEFORE)) // since 이전이라 히트 없음 — 읽기 자체는 성공
    expect(await tail.read()).toBeNull()
    expect(tail.readFailed).toBe(false)
  })

  it('히트가 있으면 당연히 readFailed=false', async () => {
    const tail = new ClaudeTranscriptTail(file, SINCE)
    await write(mainHit())
    expect(await tail.read()).not.toBeNull()
    expect(tail.readFailed).toBe(false)
  })

  it('깨진 JSON 줄은 건너뛰고 계속 읽는다', async () => {
    const tail = new ClaudeTranscriptTail(file, SINCE)
    await write('{ 깨진 줄', mainHit())
    expect((await tail.read())?.source).toBe('main')
  })

  it('발췌는 상한을 넘지 않는다', async () => {
    const tail = new ClaudeTranscriptTail(file, SINCE)
    await write(mainHit(AFTER, 'x'.repeat(500) + ' weekly limit'))
    const hit = await tail.read()
    expect(hit).not.toBeNull()
    expect(hit!.text.length).toBeLessThanOrEqual(201) // 200 + '…'
  })
})
