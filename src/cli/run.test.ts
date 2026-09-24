import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { exitCodeFor } from '../core/orchestration/cliOutput'
import { promises as fs, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import {
  errorOutput,
  exitCodeForStatus,
  ensureTrailingNewline,
  applyStdin,
  clientTimeoutMs,
  argsForCall,
  liftRequestId,
  mintRequestId,
  requestForHost,
  lostAnswerDetails,
  retryCommandLine,
  implicitArgs,
  stdinMissingError,
  refusalDetailsOf,
  shownReceipt,
  callHost,
  connectFailureEnd,
  SILENT_HOST_CODE,
  resolveGuidePath,
  readGuide,
  outputMode,
  renderErr,
  renderOk,
  startKeepalive,
  writePendingReport
} from './run'
import { siblingHostError } from './host'
import { parseArgs } from '../core/orchestration/cliArgs'
import { createHostOrch } from '../host/orch'
import { DEFAULT_ASK_TIMEOUT_MS, DEFAULT_CHECK_TIMEOUT_MS } from '../core/orchestration/types'
import { KEEPALIVE_MS } from '../core/orchestration/cliKeepalive'
import type { HostConnection } from '../core/host/connect'
import type { ClientMessage, HostMessage } from '../core/host/protocol'
import {
  parsePendingReport,
  pendingReportFileName,
  pendingReportTempName,
  pendingReportsDirIn
} from '../core/orchestration/pendingReports'

/**
 * A command line back into the argv a POSIX shell would hand the program, **and every place that
 * shell would expand something on the way**.
 *
 * **It has to live here and not in the source**, because the claim being tested is that the line this
 * program *writes* is a line a shell can *run*: a splitter that came out of the same file as the
 * quoter would agree with it whatever either of them did. This one knows only what the shell knows.
 *
 * **`expansions` is the half that matters and the half the first version of this helper could not
 * see.** Splitting a line the way a shell splits it says nothing about whether the shell would first
 * run something inside it: `"cost is $(date)"` splits into one tidy token *and* executes `date`. So
 * every `$` and backtick that is not inside single quotes is recorded here, and a line that is safe
 * to publish is one that leaves this list empty.
 */
const posixArgv = (line: string): { argv: string[]; expansions: string[] } => {
  const argv: string[] = []
  const expansions: string[] = []
  let cur = ''
  let started = false
  /** `null` outside quotes, otherwise the quote character we are inside. */
  let quote: "'" | '"' | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    // Single quotes expand nothing at all and end only at the next single quote — not even a
    // backslash is special inside them, which is the whole reason the quoter uses them.
    if (quote === "'") {
      if (c === "'") quote = null
      else cur += c
      started = true
      continue
    }
    if (c === '\\' && quote === null && line[i + 1] !== undefined) {
      cur += line[++i]
      started = true
      continue
    }
    if (quote === '"' && c === '\\' && ['"', '\\', '$', '`'].includes(line[i + 1])) {
      cur += line[++i]
      continue
    }
    if (c === '$' || c === '`') expansions.push(line.slice(i, i + 12))
    if (c === "'" || c === '"') {
      if (quote === c) quote = null
      else if (quote === null) quote = c
      else cur += c
      started = true
      continue
    }
    if (c === ' ' && quote === null) {
      if (started) argv.push(cur)
      cur = ''
      started = false
      continue
    }
    cur += c
    started = true
  }
  if (started) argv.push(cur)
  return { argv, expansions }
}
const splitCommandLine = (line: string): string[] => posixArgv(line).argv

describe('errorOutput', () => {
  // 스크립트가 기대는 것은 봉투다(설계 §7) — 코드는 기계의 것이고 문구는 사람의 것이다.
  it('오류를 봉투 한 줄로 감싼다', () => {
    expect(JSON.parse(errorOutput('boom'))).toEqual({
      ok: false,
      error: { code: 'FAILED', message: 'boom', details: {}, nextSteps: [] }
    })
  })
  it('코드를 주면 그것이 실린다', () => {
    expect(JSON.parse(errorOutput('nope', 'NOT_FOUND')).error.code).toBe('NOT_FOUND')
  })
  // 어떤 명령이 실패했는지가 다음에 칠 것을 가른다 — 봉투를 짓는 자리에서 그것을 받는 이유다.
  it('명령을 주면 그 명령에 맞는 nextSteps 가 실린다', () => {
    expect(JSON.parse(errorOutput('unknown job: x', 'NOT_FOUND', 'jobs-get')).error.nextSteps).toEqual([
      'astera jobs list'
    ])
    expect(JSON.parse(errorOutput('unknown job: x', 'NOT_FOUND')).error.nextSteps).toEqual(['astera help'])
  })
})

describe('exitCodeForStatus', () => {
  it('2xx는 0이다', () => {
    expect(exitCodeForStatus(200)).toBe(0)
    expect(exitCodeForStatus(299)).toBe(0)
  })
  // 스크립트가 분기할 수 있어야 한다 — 인자를 잘못 준 것과 그런 id 가 없는 것은 다른 일이다
  it('상태마다 다른 종료 코드를 준다 (설계 §8)', () => {
    expect(exitCodeForStatus(400)).toBe(2)
    expect(exitCodeForStatus(403)).toBe(5)
    expect(exitCodeForStatus(404)).toBe(4)
    expect(exitCodeForStatus(409)).toBe(6)
  })
  // 모르는 상태를 그럴듯한 코드로 넘겨짚지 않는다 — 짐작이 스크립트의 분기를 조용히 틀리게 한다
  it('모르는 상태는 일반 실패다', () => {
    expect(exitCodeForStatus(500)).toBe(1)
    expect(exitCodeForStatus(199)).toBe(1)
  })
  it('ask의 타임아웃 응답은 200이므로 0이다 (타임아웃은 오류가 아니라 정보)', () => {
    // 서버는 ask --wait 타임아웃을 {answered:false, timedOut:true} 본문 + 200으로 응답한다.
    expect(exitCodeForStatus(200)).toBe(0)
  })
})

describe('ensureTrailingNewline', () => {
  it('줄바꿈이 없으면 붙인다', () => {
    expect(ensureTrailingNewline('abc')).toBe('abc\n')
  })
  it('이미 있으면 그대로 둔다', () => {
    expect(ensureTrailingNewline('abc\n')).toBe('abc\n')
  })
})

describe('applyStdin', () => {
  it('wantsStdin에 있는 키만 stdin 텍스트로 채운다', () => {
    const r = applyStdin({ args: { a: 1 }, keys: ['spec'], text: '본문' })
    expect(r).toEqual({ a: 1, spec: '본문' })
  })
  it('여러 키를 같은 텍스트로 채운다', () => {
    const r = applyStdin({ args: {}, keys: ['question', 'body'], text: 'q' })
    expect(r).toEqual({ question: 'q', body: 'q' })
  })
  it('원본 args 객체를 변형하지 않는다', () => {
    const args = { a: 1 }
    applyStdin({ args, keys: ['spec'], text: '본문' })
    expect(args).toEqual({ a: 1 })
  })
  // `astera sessions send --text - <<'EOF'` 의 본문은 줄바꿈으로 끝난다. 그대로 치면 Enter 앞에
  // 줄바꿈이 하나 더 간다 — 꼭 하나만 뗀다. 다른 명령의 본문은 그대로다.
  it('sessions send 의 --text 에서만 끝 줄바꿈을 꼭 하나 뗀다', () => {
    expect(applyStdin({ cmd: 'sessions-send', args: {}, keys: ['text'], text: 'echo hi\n' })).toEqual({ text: 'echo hi' })
    expect(applyStdin({ cmd: 'sessions-send', args: {}, keys: ['text'], text: 'echo hi\r\n' })).toEqual({ text: 'echo hi' })
    expect(applyStdin({ cmd: 'sessions-send', args: {}, keys: ['text'], text: 'a\n\n' })).toEqual({ text: 'a\n' })
    expect(applyStdin({ cmd: 'sessions-send', args: {}, keys: ['text'], text: 'a' })).toEqual({ text: 'a' })
    expect(applyStdin({ cmd: 'send', args: {}, keys: ['body'], text: 'b\n' })).toEqual({ body: 'b\n' })
  })
})

/**
 * **`-` 는 "값이 지금 온다" 는 약속이고, 아무것도 안 오면 그 약속이 깨진 것이다** — 값이 빈 글자라는
 * 뜻은 아니다. 그냥 넘기면 가장 비싼 경우가 조용하다: `send --type worker_done --body -` 는 본문을
 * 요구하지 않으므로(`workerDoneFieldError`) 빈 보고가 0 으로 올라가고, Dispatch 는 닫히고,
 * 코디네이터는 요약이 사라진 Task 를 끝난 것으로 읽는다.
 */
describe('stdinMissingError — 빈 stdin 은 값이 아니다', () => {
  it('`-` 를 쓴 칸이 있는데 아무것도 안 오면 거절 문구를 준다', () => {
    expect(stdinMissingError({ keys: ['body'], text: '' })).toContain('--body')
    expect(stdinMissingError({ keys: ['body'], text: '' })).toContain('standard input')
  })

  it('캐멀케이스 칸은 친 모양으로 되돌려 댄다', () => {
    expect(stdinMissingError({ keys: ['taskId'], text: '' })).toContain('--task-id')
  })

  it('글자가 왔으면 아무 말도 하지 않는다 — 공백 한 칸도 값이다', () => {
    expect(stdinMissingError({ keys: ['body'], text: '보고' })).toBeNull()
    expect(stdinMissingError({ keys: ['body'], text: ' ' })).toBeNull()
  })

  it('`-` 를 쓴 칸이 없으면 stdin 이 비어도 상관없다', () => {
    expect(stdinMissingError({ keys: [], text: '' })).toBeNull()
  })
})

describe('clientTimeoutMs', () => {
  // 서버(server.ts)와 같은 상수(core/orchestration/types.ts)를 가져와 대조한다 — 숫자를 여기
  // 하드코딩하면 한쪽만 바뀌었을 때 어긋남을 다시 놓친다(리뷰 발견: ask 기본값이 서버보다
  // 짧아 서버가 응답하기 전에 클라이언트가 먼저 끊었다).
  it('ask 기본값(--timeout-ms 없음)은 서버의 ask 기본 시한보다 크다 — 클라이언트가 서버보다 먼저 끊으면 안 된다', () => {
    expect(clientTimeoutMs({ cmd: 'ask', args: {} })).toBeGreaterThan(DEFAULT_ASK_TIMEOUT_MS)
  })
  it('check 기본값(--timeout-ms 없음)은 서버의 check 기본 시한보다 크다', () => {
    expect(clientTimeoutMs({ cmd: 'check', args: {} })).toBeGreaterThan(DEFAULT_CHECK_TIMEOUT_MS)
  })
  it('--timeout-ms를 명시하면 그 값 위에 고정된 여유를 더해 그대로 쓴다 (명령·기본값과 무관)', () => {
    const headroom = clientTimeoutMs({ cmd: 'ask', args: { timeoutMs: 1000 } }) - 1000
    expect(clientTimeoutMs({ cmd: 'ask', args: { timeoutMs: 5000 } })).toBe(5000 + headroom)
    expect(clientTimeoutMs({ cmd: 'check', args: { timeoutMs: 5000 } })).toBe(5000 + headroom)
  })
})

describe('argsForCall — run-create의 --cwd 기본값 (task-13a)', () => {
  // run-create 는 --cwd 생략 시 process.cwd() 로 메꾸지만 그건 답하는 프로세스(Host)의 cwd 라
  // CLI 프로세스와 무관하다 — CLI 가 자기 cwd 를 채워 보내야 한다.
  it('--cwd 없이 run-create를 보내면 CLI의 cwd를 args에 채운다', () => {
    expect(argsForCall({ cmd: 'run-create', args: { objective: 'o' }, cwd: 'D:/my-cwd' })).toEqual({
      objective: 'o',
      cwd: 'D:/my-cwd'
    })
  })
  // **명시한 값은 이 플랫폼의 절대 경로여야 그대로 간다.** 'D:/explicit' 는 posix 에서 상대 경로라
  // CLI 의 cwd 에 대해 풀린다(바로 아래 상대 경로 시험) — 그래서 path.resolve 로 짓는다.
  const explicit = path.resolve('/explicit')
  it('--cwd가 명시되면 CLI의 cwd보다 그것이 이긴다', () => {
    expect(
      argsForCall({ cmd: 'run-create', args: { objective: 'o', cwd: explicit }, cwd: 'D:/my-cwd' })
    ).toEqual({ objective: 'o', cwd: explicit })
  })
  // jobs create 는 run-create 로 간다 — 같은 이유로 같은 기본값이다
  it('jobs create 에도 CLI의 cwd를 채우고, 명시한 것이 이긴다', () => {
    expect(argsForCall({ cmd: 'jobs-create', args: { objective: 'o' }, cwd: 'D:/my-cwd' })).toEqual({
      objective: 'o',
      cwd: 'D:/my-cwd'
    })
    expect(
      argsForCall({ cmd: 'jobs-create', args: { objective: 'o', cwd: explicit }, cwd: 'D:/my-cwd' })
    ).toEqual({ objective: 'o', cwd: explicit })
  })
  // **상대 경로는 CLI 의 cwd 에 대해 푼다.** 그대로 보내면 받는 프로세스(Host·앱)의 cwd 에 대해
  // 풀리고, 그 회차의 워커가 엉뚱한 폴더에서 뜬다.
  it('명시한 상대 --cwd 는 CLI의 cwd 에 대해 절대 경로가 된다', () => {
    const here = path.resolve('/work/repo/sub')
    for (const cmd of ['jobs-create', 'run-create']) {
      expect(argsForCall({ cmd, args: { objective: 'o', cwd: '.' }, cwd: here })).toEqual({
        objective: 'o',
        cwd: here
      })
      expect(argsForCall({ cmd, args: { objective: 'o', cwd: '../other' }, cwd: here }).cwd).toBe(
        path.resolve(here, '../other')
      )
    }
  })
  it('run-create가 아닌 명령에는 CLI의 cwd를 채우지 않는다', () => {
    expect(argsForCall({ cmd: 'tasks-list', args: {}, cwd: 'D:/my-cwd' })).toEqual({})
  })
})

// **영수증이 가림막을 도는 길이 되면 안 된다.** `publicFor` 는 친 명령으로 가리는데(run.ts),
// `requests show` 가 싣고 오는 것은 **다른 명령의 답**이고 `requests-show` 는 그 표에 없다 — 그대로
// 두면 공개 표면이 가리는 칸이 영수증을 통해 그대로 나간다. cliPublic 이 한 경계이려면 여기서
// 실려 온 명령으로 가려야 한다.
describe('shownReceipt — 영수증 속 답은 그 답을 낸 명령으로 가린다', () => {
  const receipt = (cmd: string, body: unknown): Record<string, unknown> => ({
    id: 'rq-1',
    state: 'completed',
    cmd,
    at: 'T',
    hostStartedAt: 'T0',
    interpretation: 'Request rq-1 already took effect …',
    response: { status: 200, body }
  })

  it('공개 명령의 답은 그 명령의 허용 목록만 남는다', () => {
    const shown = shownReceipt(
      receipt('tasks-list', [
        { id: 'tsk_1', title: 'work', status: 'done', policySnapshot: { secret: true }, checkHistory: [1] }
      ])
    ) as { response: { body: Record<string, unknown>[] } }
    expect(shown.response.body[0]).toEqual({ id: 'tsk_1', title: 'work', status: 'done' })
  })

  it('영수증 자신의 칸과 기록된 상태는 그대로다 — 가리는 것은 실려 온 본문뿐이다', () => {
    const shown = shownReceipt(receipt('tasks-list', [{ id: 'tsk_1', policySnapshot: {} }])) as Record<
      string,
      unknown
    >
    expect(shown.id).toBe('rq-1')
    expect(shown.state).toBe('completed')
    expect(shown.cmd).toBe('tasks-list')
    expect((shown.response as { status: number }).status).toBe(200)
  })

  // 세션 전용 명령은 애초에 가려진 적이 없다(cliPublic 의 SHAPE). 표에 없는 것을 여기서 거절로
  // 바꾸면 재생이 원래 명령보다 적게 보여 주게 된다.
  it('표에 없는 명령의 답은 통째로 지나간다', () => {
    const body = { dispatchId: 'dsp_1', sessionId: 'ses_1', cwd: 'D:/x', specPath: 'D:/x/spec.md' }
    const shown = shownReceipt(receipt('worker-start', body)) as { response: { body: unknown } }
    expect(shown.response.body).toEqual(body)
  })

  it('response 가 없는 영수증(pending·absent)은 그대로 돌려준다', () => {
    const absent = { id: 'rq-1', state: 'absent', hostStartedAt: 'T0', interpretation: '…' }
    expect(shownReceipt(absent)).toBe(absent)
    expect(shownReceipt(null)).toBe(null)
  })
})

// `--request-id` 는 명령의 인자가 아니라 이 부름에 대한 사실이다(요청 영수증 설계 §8). 봉투가
// `session` 옆에 제 칸으로 싣고, `args` 에 남으면 handleCommand 가 그 명령의 플래그로 보게 된다 —
// 못 보낸 보고의 큐 파일에도 그 명령의 플래그인 양 적힌다.
describe('liftRequestId — --request-id 는 인자가 아니라 메시지를 탄다', () => {
  it('실린 id 는 args 에서 빠져 request 로 간다', () => {
    expect(liftRequestId({ objective: 'o', requestId: 'req-1' })).toEqual({
      request: 'req-1',
      args: { objective: 'o' }
    })
  })

  it('없으면 args 를 그대로 둔다 — 키를 안 단 쪽은 아무것도 치르지 않는다', () => {
    const args = { objective: 'o' }
    const r = liftRequestId(args)
    expect(r).toEqual({ args: { objective: 'o' } })
    expect((r as { args: Record<string, unknown> }).args).toBe(args)
  })

  it('원본 args 를 변형하지 않는다', () => {
    const args = { objective: 'o', requestId: 'req-1' }
    liftRequestId(args)
    expect(args.requestId).toBe('req-1')
  })

  // **조용히 버리는 것이 이 설계가 가장 피하려는 실패다.** 값 없는 `--request-id` 는 파서가 `true`
  // 로 만들고, 그것을 무시하면 부르는 쪽은 보호받는다고 믿은 채 보호받지 못한다.
  it('값 없는 --request-id 는 조용히 버리지 않고 거절한다', () => {
    expect(liftRequestId({ requestId: true })).toEqual({ error: expect.stringContaining('--request-id') })
    expect(liftRequestId({ requestId: '' })).toEqual({ error: expect.stringContaining('--request-id') })
  })
})

// **키를 안 단 쪽에도 id 가 있다**(설계 §8). 영수증의 값이 가장 큰 자리가 실패를 대비하지 않은
// 호출자이고, 그쪽은 답을 잃었을 때 물어볼 것이 아무것도 없다 — 그리고 id 가 없으면 잃은 답의
// 오류가 id 를 댈 수 없다. 그 문장이 이 기능이 쓰려는 문장이다.
describe('mintRequestId — 키를 안 단 호출도 id 를 싣는다', () => {
  // **두 번 같은 id 를 보내면 두 번째 명령이 첫 번째의 답을 받는다** — 새긴 id 가 재생을 부르는
  // 유일한 길이 "다시 내미는 것" 이므로, 이쪽이 스스로 되풀이하면 그 약속이 깨진다.
  it('같은 id 를 두 번 내놓지 않는다', () => {
    const minted = new Set(Array.from({ length: 500 }, () => mintRequestId()))
    expect(minted.size).toBe(500)
  })

  // Host 가 거절하지 않을 모양이어야 한다 — 저쪽의 검사는 "비어 있지 않고, 200자 이하이고,
  // 제어문자가 없다" 이다(host/orch.ts 의 badRequestId).
  it('Host 가 받아 주는 모양이다', () => {
    const id = mintRequestId()
    expect(id.length).toBeGreaterThan(0)
    expect(id.length).toBeLessThanOrEqual(200)
    expect(id).toMatch(/^[0-9a-f-]+$/)
  })
})

/**
 * **두 갈래를 한 파일에 둔다**(설계 §13 단계 9). 앞쪽만 내보내면 옛 Host 를 향한 모든 명령이
 * 깨지고, 뒤쪽만 내보내면 보호를 부탁한 사람이 보호받지 못한 채 그것을 모른다. 갈래가 갈리는
 * 자리가 하나이므로 시험도 한 자리에 있어야 한다.
 */
describe('requestForHost — 실은 id 와 새긴 id 는 옛 Host 앞에서 갈라진다', () => {
  const against = (features: string[], presented: boolean): ReturnType<typeof requestForHost> =>
    requestForHost({ request: 'req-1', presented, features, address: '\\\\.\\pipe\\astera' })

  it('영수증을 아는 Host 에는 둘 다 실려 나간다', () => {
    expect(against(['orch', 'requests'], true)).toEqual({ send: 'req-1' })
    // 키를 안 단 부름도 id 를 싣는다 — 그것이 8단계가 한 일이고, 전선에 닿는 자리가 여기다.
    expect(against(['orch', 'requests'], false)).toEqual({ send: 'req-1' })
  })

  /** 조용히 흘리면 부르는 쪽은 보호받는다고 믿은 채 보호받지 못한다. 코드는 옆의
   *  `HOST_FEATURE_ORCH` 검사와 같은 9 다 — 같은 사실(저쪽이 옛 빌드다)이기 때문이다. */
  it('실은 id 는 조용히 버려지지 않고 9 로 끝난다', () => {
    const r = against(['orch'], true)
    expect(r).toEqual({ error: { code: 'VERSION_MISMATCH', message: expect.stringContaining('older build') } })
    expect(exitCodeFor((r as { error: { code: 'VERSION_MISMATCH' } }).error.code)).toBe(9)
    // 주소를 댄다 — 어느 Host 가 옛것인지 말하지 않으면 사람이 할 수 있는 일이 없다.
    expect((r as { error: { message: string } }).error.message).toContain('\\\\.\\pipe\\astera')
  })

  /** 반대쪽으로 거절하면 옛 Host 를 향한 모든 명령이, 아무도 부탁한 적 없는 보호 때문에 깨진다. */
  it('새긴 id 는 조용히 버려지고 명령은 예전 그대로 돈다', () => {
    // 그리고 버려진 id 는 봉투에 칸조차 만들지 않는다 — 아래 callHost 묶음의 "id 가 없으면 그 칸을
    // 만들지 않는다" 가 그 절반을 지킨다. 칸이 있고 값이 없는 것과 애초에 안 보낸 것을 저쪽이 가를
    // 수 있어야 한다.
    expect(against(['orch'], false)).toEqual({ send: undefined })
  })
})

/**
 * **이미 도는 요청이라 거절당한 호출은 "지금 뭐가 도나" 가 아니라 "그 요청이 어떻게 됐나" 를
 * 물어야 한다**(요청 영수증 설계 §7). 런타임의 `pending` 문장도 기다렸다 다시 물으라고 말하고,
 * 그 "다시 묻기" 는 `requests show` 다. 문구가 아니라 봉투의 칸으로 가른다 — Host 가 그 409 에
 * `requestId` 를 싣고, 이 함수가 그것을 `details` 로 올린다.
 */
describe('refusalDetailsOf — 요청을 이름 댄 거절만 그 id 를 싣는다', () => {
  it('본문에 requestId 가 있으면 details 로 올린다', () => {
    expect(refusalDetailsOf({ error: 'request rq-1 is already running', requestId: 'rq-1' })).toEqual({
      requestId: 'rq-1'
    })
  })

  it('없거나 모양이 아니면 아무것도 올리지 않는다 — 없던 details 를 만들지 않는다', () => {
    expect(refusalDetailsOf({ error: 'unknown job: job_x' })).toBeUndefined()
    expect(refusalDetailsOf({ requestId: '' })).toBeUndefined()
    expect(refusalDetailsOf({ requestId: 7 })).toBeUndefined()
    expect(refusalDetailsOf(null)).toBeUndefined()
    expect(refusalDetailsOf('boom')).toBeUndefined()
  })

  // phase D. `tasks add --validate` 의 없는 구성 id 는 404 에 계획 id 를 싣는다 — nextSteps 가
  // `run-configs list --job <jobId>` 를 그 값으로 채운다(cliOutput).
  it('본문의 jobId 도 details 로 올린다', () => {
    expect(refusalDetailsOf({ error: 'unknown run configuration: x', jobId: 'job_1' })).toEqual({ jobId: 'job_1' })
    expect(refusalDetailsOf({ jobId: 3 })).toBeUndefined()
  })

  // Host S2 fix round, ruling (a): a spawn refused by a Host that is leaving says so as a field.
  it('본문의 retry 도 details 로 올린다', () => {
    expect(refusalDetailsOf({ error: 'failed to start worker: the Host is retiring', retry: 'host-retiring' })).toEqual({ retry: 'host-retiring' })
  })

  // The Host's repair refusal names the profile file; `STEPS.CONFLICT` then offers no command.
  it('본문의 repair 도 details 로 올린다', () => {
    expect(refusalDetailsOf({ error: 'accounts.json is not valid JSON; open Astera to repair it', repair: 'accounts.json' })).toEqual({ repair: 'accounts.json' })
    expect(refusalDetailsOf({ repair: true })).toBeUndefined()
  })
})

describe('resolveGuidePath', () => {
  it('ASTERA_SKILLS 환경변수가 가리키는 디렉터리 아래 orchestration-guide.md를 가리킨다', () => {
    const r = resolveGuidePath({ args: {}, env: { ASTERA_SKILLS: '/opt/skills' } })
    expect(r).toEqual({ ok: true, path: path.join('/opt/skills', 'orchestration-guide.md') })
  })
  it('--skills-dir 인자가 있으면 환경변수보다 우선한다', () => {
    const r = resolveGuidePath({
      args: { skillsDir: '/custom' },
      env: { ASTERA_SKILLS: '/opt/skills' }
    })
    expect(r).toEqual({ ok: true, path: path.join('/custom', 'orchestration-guide.md') })
  })
  // 감사 #70. 세션 밖에서는 ASTERA_SKILLS 가 없어 `astera help` 가 1 로 끝났다. `--help` 의 첫
  // 화면이 권하는 명령이다. 그때는 `skills install` 이 스텁을 찾는 곳(바이너리 옆의 resources)을 쓴다.
  it('둘 다 없으면 바이너리 옆에 묶인 가이드를 읽는다', () => {
    const r = resolveGuidePath({ args: {}, env: {}, bundled: '/app/resources/skills' })
    expect(r).toEqual({ ok: true, path: path.join('/app/resources/skills', 'orchestration-guide.md') })
    const browser = resolveGuidePath({ args: {}, env: {}, bundled: '/app/resources/skills', guide: 'browser' })
    expect(browser).toEqual({ ok: true, path: path.join('/app/resources/skills', 'browser-guide.md') })
  })
  it('ASTERA_SKILLS 가 있으면 묶인 가이드보다 이긴다', () => {
    const r = resolveGuidePath({ args: {}, env: { ASTERA_SKILLS: '/opt/skills' }, bundled: '/app/resources/skills' })
    expect(r).toEqual({ ok: true, path: path.join('/opt/skills', 'orchestration-guide.md') })
  })
  it('둘 다 없으면 ASTERA_SKILLS를 언급하는 명확한 에러를 낸다', () => {
    const r = resolveGuidePath({ args: {}, env: {} })
    expect(r.ok).toBe(false)
    expect((r as { ok: false; error: string }).error).toContain('ASTERA_SKILLS')
  })
})

describe('readGuide', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-cli-guide-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  it('파일 내용을 그대로 읽는다', async () => {
    const p = path.join(dir, 'orchestration-guide.md')
    await fs.writeFile(p, '# guide', 'utf8')
    expect(readGuide(p)).toEqual({ ok: true, content: '# guide' })
  })
  it('파일이 없으면 경로를 담은 명확한 에러를 낸다', () => {
    const missing = path.join(dir, 'missing.md')
    const r = readGuide(missing)
    expect(r.ok).toBe(false)
    expect((r as { ok: false; error: string }).error).toContain(missing)
  })
})

describe('browser commands', () => {
  it('resolveGuidePath picks the browser guide when asked', () => {
    const r = resolveGuidePath({ args: {}, env: { ASTERA_SKILLS: 'D:/skills' }, guide: 'browser' })
    expect(r).toEqual({ ok: true, path: path.join('D:/skills', 'browser-guide.md') })
  })
  it('resolveGuidePath still defaults to the orchestration guide', () => {
    const r = resolveGuidePath({ args: {}, env: { ASTERA_SKILLS: 'D:/skills' } })
    expect(r).toEqual({ ok: true, path: path.join('D:/skills', 'orchestration-guide.md') })
  })
  it('browser-js waits for the whole script plus headroom', () => {
    expect(clientTimeoutMs({ cmd: 'browser-js', args: {} })).toBe(60_000 + 30_000)
  })
  it('an explicit --timeout-ms still wins for browser-js', () => {
    expect(clientTimeoutMs({ cmd: 'browser-js', args: { timeoutMs: 5000 } })).toBe(5000 + 30_000)
  })
})

describe('writePendingReport — the report a closed Host could not take', () => {
  let profileDir = ''
  beforeEach(async () => {
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-cli-pending-'))
  })
  afterEach(async () => {
    await fs.rm(profileDir, { recursive: true, force: true })
  })

  const report = {
    sessionId: 'sess_1',
    cmd: 'send',
    args: {
      type: 'worker_done',
      taskId: 'tsk_1',
      dispatchId: 'dsp_1',
      outcome: 'succeeded',
      body: 'done\nand said so'
    },
    queuedAt: '2026-09-10T01:02:03.004Z',
    nonce: 'abcd1234'
  }

  it('writes the report where the app will look for it', async () => {
    const r = writePendingReport({ profileDir, ...report })
    expect(r.ok).toBe(true)
    const written = (r as { ok: true; path: string }).path
    expect(path.dirname(written)).toBe(pendingReportsDirIn(profileDir))
    expect(parsePendingReport(await fs.readFile(written, 'utf8'))).toEqual({
      queuedAt: report.queuedAt,
      sessionId: report.sessionId,
      cmd: report.cmd,
      args: report.args
    })
  })

  // The window this whole path exists for is the app not running, and the moment the app comes back
  // is exactly the moment it reads the queue. A plain writeFileSync can be read half-written, and
  // the reader would find an unparseable file. So the report appears under its final name only once
  // it is whole -- the same temporary-name-then-rename the orchestration store already uses.
  it('leaves no working file beside the report it wrote', async () => {
    const r = writePendingReport({ profileDir, ...report })
    expect((r as { ok: true; path: string }).path.endsWith('.json')).toBe(true)
    expect(await fs.readdir(pendingReportsDirIn(profileDir))).toEqual([
      path.basename((r as { ok: true; path: string }).path)
    ])
  })

  it('clears its working file when the report cannot be put in place', async () => {
    const name = pendingReportFileName({ queuedAt: report.queuedAt, nonce: report.nonce })
    // A directory standing exactly where the report has to land: the write goes through and the
    // rename cannot.
    await fs.mkdir(path.join(pendingReportsDirIn(profileDir), name), { recursive: true })
    const r = writePendingReport({ profileDir, ...report })
    expect(r.ok).toBe(false)
    expect(await fs.readdir(pendingReportsDirIn(profileDir))).not.toContain(
      pendingReportTempName(name)
    )
  })

  it('makes the folder on the first report — nothing else creates it', async () => {
    writePendingReport({ profileDir, ...report })
    expect((await fs.stat(pendingReportsDirIn(profileDir))).isDirectory()).toBe(true)
  })

  it('keeps two reports queued in the same millisecond apart', async () => {
    writePendingReport({ profileDir, ...report })
    writePendingReport({ profileDir, ...report, nonce: 'ffff0000' })
    expect((await fs.readdir(pendingReportsDirIn(profileDir))).length).toBe(2)
  })

  it('answers with an error instead of throwing when the queue cannot be written', async () => {
    // A file where the folder has to go: the last line of defence failing, which the caller has to
    // be able to tell the agent about rather than crash on.
    await fs.mkdir(path.dirname(pendingReportsDirIn(profileDir)), { recursive: true })
    await fs.writeFile(pendingReportsDirIn(profileDir), 'in the way', 'utf8')
    const r = writePendingReport({ profileDir, ...report })
    expect(r.ok).toBe(false)
    expect((r as { ok: false; error: string }).error).toContain(pendingReportsDirIn(profileDir))
  })
})

describe('닿지 못했을 때의 코드', () => {
  // 스크립트가 "앱이 없다"(3)와 "명령이 실패했다"(1)를 가를 수 있어야 한다. 실제 CLI 로 돌려
  // 보고서야 나왔다 — 그 전에는 둘 다 1 이었다.
  it('앱을 찾지 못한 것은 HOST_NOT_RUNNING 이고 종료 코드 3 이다', () => {
    const e = JSON.parse(errorOutput('cannot read …', 'HOST_NOT_RUNNING'))
    expect(e.error.code).toBe('HOST_NOT_RUNNING')
    expect(exitCodeFor('HOST_NOT_RUNNING')).toBe(3)
  })
})

// F44: 파일로 답하는 길이 서 있는 전제는 "아무도 이 파일을 쓰고 있지 않다" 하나다. 접속 실패
// 세 가지 중 그것을 뜻하는 것은 하나뿐인데, 셋 다 파일로 떨어지고 있었다.
describe('connectFailureEnd — 접속 실패 셋을 가른다', () => {
  const addr = '\\\\.\\pipe\\astera-host-x'

  it('아무것도 없었을 때만 파일로 답한다', () => {
    expect(connectFailureEnd({ error: 'unreachable', address: addr })).toEqual({ fallback: true })
  })

  // 판을 보고 거절한 Host 는 돌고 있고 파일을 쥐고 있다. `orch` 를 알리지 않는 Host 와 같은 자리다.
  it('판이 갈린 것은 VERSION_MISMATCH 이고 파일을 읽지 않는다', () => {
    const end = connectFailureEnd({ error: 'protocol', address: addr })
    expect(end.fallback).toBe(false)
    expect((end as { code: string }).code).toBe('VERSION_MISMATCH')
    expect(exitCodeFor('VERSION_MISMATCH')).toBe(9)
    expect((end as { message: string }).message).toContain(addr)
  })

  // 파이프는 열렸는데 hello 가 안 왔다 — 살아 있는데 답하지 않는 Host 이고, 이 저장소는 그것을
  // 위한 회복 코드를 따로 두고 있다. 그 파일을 읽어 running: false 로 답하면 거짓말이다.
  it('답하지 않는 것은 TIMEOUT 이고 파일을 읽지 않는다', () => {
    const end = connectFailureEnd({ error: 'timeout', address: addr })
    expect(end.fallback).toBe(false)
    expect((end as { code: string }).code).toBe('TIMEOUT')
    expect(exitCodeFor('TIMEOUT')).toBe(7)
  })

  // hello 전의 침묵과 답 전의 침묵은 같은 사실이다. `stuck` 은 1 로 끝나고 있었고,
  // 그러면 스크립트가 "살아 있는데 답하지 않는 Host" 를 두 번 분기해야 한다.
  it('두 침묵은 한 코드를 쓴다', () => {
    expect((connectFailureEnd({ error: 'timeout', address: addr }) as { code: string }).code).toBe(
      SILENT_HOST_CODE
    )
    expect(exitCodeFor(SILENT_HOST_CODE)).toBe(7)
  })
})

// 감사 #12. 주소에 판이 들어가서, 다른 판의 CLI 는 살아 있는 Host 를 못 보고 그 Host 가 쓰는 파일을
// 읽었다. 찾았으면 파일로 답하지 않고 9 로 끝난다 — 무엇과 무엇이 갈렸는지를 싣고.
describe('siblingHostError — 다른 판의 Host 가 이 프로필을 쥐고 있다', () => {
  const found = { protocol: 4, address: '\\\\.\\pipe\\astera-host-abc-v4' }

  it('VERSION_MISMATCH 이고, 두 판과 주소를 말하며, 파일을 읽지 않았다고 한다', () => {
    const e = siblingHostError({ found, cliProtocol: 3 })
    expect(e.code).toBe('VERSION_MISMATCH')
    expect(exitCodeFor(e.code)).toBe(9)
    expect(e.message).toContain('protocol 4')
    expect(e.message).toContain('protocol 3')
    expect(e.message).toContain(found.address)
    expect(e.message).toContain('not read from the file')
    expect(e.message).toContain('Quit Astera')
    expect(e.details).toEqual({ hostProtocol: 4, hostAddress: found.address, cliProtocol: 3 })
  })
})

describe('출력 모드', () => {
  // **TTY 로 고를 수가 없다.** 이 CLI 는 ELECTRON_RUN_AS_NODE 로 도는 electron.exe 이고,
  // 진짜 콘솔에서도 isTTY 가 undefined 다(같은 콘솔에서 node 는 true). 그래서 기본은 JSON 이다.
  it('기본은 JSON 이고 사람용은 켜는 것이다', () => {
    expect(outputMode({ json: false, human: false, quiet: false })).toBe('json')
    expect(outputMode({ json: false, human: true, quiet: false })).toBe('human')
    expect(outputMode({ json: false, human: false, quiet: true })).toBe('quiet')
    expect(outputMode({ json: true, human: false, quiet: false })).toBe('json')
  })

  // 한쪽을 조용히 무시하면 사람은 자기가 친 것이 들었다고 믿는다
  it('모드를 둘 이상 주면 거절하고 무엇을 줘는지 말한다', () => {
    const r = outputMode({ json: true, human: false, quiet: true })
    expect(typeof r).toBe('object')
    expect((r as { error: string }).error).toBe('--json and --quiet ask for different things; pick one')
    expect(typeof outputMode({ json: false, human: true, quiet: true })).toBe('object')
  })
})

describe('renderOk / renderErr', () => {
  const jobs = [{ id: 'job_1', objective: 'o', outcome: 'running', progress: { done: 1, total: 2 } }]

  it('json 은 봉투다', () => {
    expect(JSON.parse(renderOk('jobs-list', jobs, 'json'))).toEqual({
      ok: true,
      data: { jobs }
    })
  })

  it('human 은 칸을 맞춘 표다', () => {
    expect(renderOk('jobs-list', jobs, 'human')).toBe('RUNNING  job_1  o  1/2')
  })

  it('quiet 은 id 만 낸다', () => {
    expect(renderOk('jobs-list', jobs, 'quiet')).toBe('job_1')
  })

  // 사람용이 없는 명령은 JSON 으로 되돌린다 — 억지로 표를 씨우면 가이드가 시키는 것을 못 읽는다
  it('사람용이 없는 명령은 human 에서도 JSON 이다', () => {
    const out = renderOk('dispatch-show', { id: 'd1' }, 'human')
    expect(JSON.parse(out)).toEqual({ ok: true, data: { id: 'd1' } })
  })

  it('사람에게는 봉투가 아니라 문장이다', () => {
    expect(renderErr({ code: 'NOT_FOUND', message: 'unknown run: nope' }, 'human')).toBe(
      'error: unknown run: nope\ntry:\n  astera help'
    )
    expect(JSON.parse(renderErr({ code: 'NOT_FOUND', message: 'x' }, 'json')).error.code).toBe('NOT_FOUND')
  })

  // 사람도 다음에 칠 것을 받는다. 봉투에는 이미 실려 있으므로 JSON 쪽에 문장을 덧붙이지 않는다 —
  // 같은 것을 두 모양으로 두 번 내보내면 읽는 쪽이 어느 것이 계약인지 모른다.
  it('사람용에는 칠 명령이 붙고, JSON 에는 봉투 안에만 있다', () => {
    expect(renderErr({ code: 'HOST_NOT_RUNNING', message: 'cannot reach the Host' }, 'human')).toBe(
      'error: cannot reach the Host\ntry:\n  astera host start'
    )
    const json = renderErr({ code: 'HOST_NOT_RUNNING', message: 'cannot reach the Host' }, 'json')
    expect(json).not.toContain('try:')
    expect(JSON.parse(json).error.nextSteps).toEqual(['astera host start'])
  })

  // 칠 것이 없는 코드는 줄을 늘리지 않는다
  it('할 것이 없으면 문장 하나뿐이다', () => {
    expect(renderErr({ code: 'FAILED', message: 'boom' }, 'human')).toBe('error: boom')
  })

  /**
   * **재생 표시는 `data` 밖, `ok` 옆이다**(요청 영수증 설계 §8). `data` 의 모양은 그 명령이 공표한
   * 계약이므로 거기 칸을 더하면 `jobs list` 가 돌려주는 것이 바뀐다. 칸을 더하는 것은 `CLI_PROTOCOL`
   * 을 올리지 않는다 — 올리는 때는 읽는 쪽이 고쳐야 하는 변화가 있을 때뿐이다.
   */
  it('재생은 봉투 맨 위에 표시가 붙고 data 는 그대로다', () => {
    expect(JSON.parse(renderOk('jobs-list', jobs, 'json', 'replayed'))).toEqual({
      ok: true,
      replayed: true,
      data: { jobs }
    })
    // 재생이 아닌 답에는 칸 자체가 없다 — `false` 를 늘 실으면 영수증을 부탁한 적 없는 호출자 앞에
    // 영수증 이야기가 놓인다.
    expect(Object.hasOwn(JSON.parse(renderOk('jobs-list', jobs, 'json')), 'replayed')).toBe(false)
  })

  /**
   * **관찰한 답은 `replayed` 가 아니라 `observed` 다**(설계 §7). `replayed` 가 공표한 문장은 "명령을
   * 두 번 돌리지 않았다" 이고, `check --ack --wait` 의 관찰은 폴링을 다시 돌려 아무도 못 본 배달을
   * 열 수 있으므로 그 문장이 거짓이 된다. 그 표시를 보고 "이미 처리한 본문" 이라며 건너뛰는 호출자는
   * 그 배치와 그 배달 id 를 잃는다.
   *
   * **그리고 `replayed` 만 아는 옛 읽는 쪽에는 아무 표시도 안 보인다** — 그쪽이 안전한 방향이다.
   * 그쪽에 보이는 것은 첫 답이고, 실제로 그것은 첫 답이 맞다.
   */
  it('관찰한 답은 다른 낱말을 쓴다', () => {
    const observed = JSON.parse(renderOk('check', { count: 1, messages: [] }, 'json', 'observed'))
    expect(observed.observed).toBe(true)
    expect(Object.hasOwn(observed, 'replayed'), 'observed 가 replayed 로도 나갔다').toBe(false)
  })

  /** 재생된 실패도 표시가 붙는다. 종료 코드는 원래의 것이고(재생의 요점이 그것이다), 표시가 더하는
   *  것은 "이 404 는 이미 일어난 부름의 답" 이라는 사실 하나다. */
  it('재생된 실패 봉투에도 같은 표시가 붙는다', () => {
    const json = JSON.parse(
      renderErr({ code: 'NOT_FOUND', message: 'unknown run: run_x' }, 'json', 'runs-get', 'replayed')
    )
    expect(json.replayed).toBe(true)
    expect(json.error.code).toBe('NOT_FOUND')
    expect(exitCodeFor('NOT_FOUND')).toBe(4)
  })

  // 사람용 두 모드는 표시를 싣지 않는다 — 봉투를 읽는 것은 스크립트이고, `--quiet` 는 id 목록이라
  // 얹을 자리조차 없다.
  it('human·quiet 에는 표시가 없다', () => {
    expect(renderOk('jobs-list', jobs, 'human', 'replayed')).toBe('RUNNING  job_1  o  1/2')
    expect(renderOk('jobs-list', jobs, 'quiet', 'observed')).toBe('job_1')
  })
})

/**
 * **답이 아예 오지 않은 끝이 싣고 나가는 것**(요청 영수증 설계 §8). 이 문장이 이 기능이 있는
 * 이유다 — 여기 네 요청 id 가 있고, 이렇게 물어보고, 이렇게 다시 치면 된다.
 */
describe('lostAnswerDetails — 잃은 답의 회복 줄', () => {
  const argv = ['worker-start', '--task', 'tsk_1', '--agent', 'codex']

  it('요청 id 와 물을 명령과 다시 칠 명령을 싣는다', () => {
    expect(lostAnswerDetails({ argv, request: 'rq-1' })).toEqual({
      requestId: 'rq-1',
      queryCommand: 'astera requests show --id rq-1',
      retryCommand: 'astera worker-start --task tsk_1 --agent codex --request-id rq-1'
    })
  })

  /** 옛 Host 앞에서 새긴 id 는 빠졌고(`requestForHost`), 연결이 아예 안 선 끝에서는 아무것도 보내지
   *  않았다. 둘 다 물어볼 영수증이 없다 — id 를 대면 `absent` 밖에 못 받는 명령으로 보내는 셈이다. */
  it('보낸 id 가 없으면 아무것도 싣지 않는다', () => {
    expect(lostAnswerDetails({ argv, request: undefined })).toEqual({})
  })

  /**
   * **stdin 으로 값을 받은 부름에는 다시 칠 줄이 없다 — 그래서 내보내지 않는다.**
   *
   * `parseArgs` 는 `-` 값을 `args` 에 넣지 않고(`applyStdin` 이 나중에 채운다), 그래서 argv 에 남는
   * 것은 맨 `-` 뿐이다. 그 줄을 찍으면 본문이 빠진 줄이 된다. **두 결말이 다 나쁘다**: Host 가 그
   * 사이 다시 섰으면 빈 본문으로 `worker_done` 이 0 으로 올라가 워커의 보고가 사라지고, Host 가 살아
   * 있으면 지문이 달라 400 이 나며 그 문구를 곧이 따르면 새 id 로 **중복**을 만든다 — 이 기능이 막으려는
   * 바로 그것이다.
   *
   * **본문을 줄에 박아 넣지도 않는다**: 길 수 있고, 비밀을 실을 수 있고, 돌아갈 것처럼 생겼는데 안
   * 도는 줄이 애초에 이 사달을 냈다. 대신 칠 수 있는 한 문장을 준다.
   */
  it('stdin 으로 값을 받았으면 retryCommand 대신 무엇을 하라는 문장이 나간다', () => {
    const d = lostAnswerDetails({
      argv: ['send', '--type', 'worker_done', '--body', '-'],
      request: 'rq-1',
      fromStdin: ['body']
    })
    expect(Object.hasOwn(d, 'retryCommand'), '다시 칠 수 없는 줄을 내보냈다').toBe(false)
    expect(d.queryCommand).toBe('astera requests show --id rq-1')
    expect(d.retryNote).toContain('--body')
    expect(d.retryNote).toContain('--request-id rq-1')
    expect(d.retryNote).toContain('stdin')
  })

  /** 여러 칸이 stdin 을 읽었으면 전부 댄다 — 어느 것을 다시 넣어야 하는지가 그 문장의 값이다. */
  it('stdin 을 읽은 칸이 여럿이면 전부 이름을 댄다', () => {
    const d = lostAnswerDetails({
      argv: ['task-create', '--spec', '-'],
      request: 'rq-1',
      fromStdin: ['spec', 'taskId']
    })
    expect(d.retryNote).toContain('--spec')
    // 캐멀케이스는 친 모양으로 되돌린다 — `--taskId` 라는 플래그는 없다.
    expect(d.retryNote).toContain('--task-id')
  })

  /** `browser js` 는 줄에 토큰조차 없다 — 스크립트가 통째로 stdin 이다. 같은 규칙이 덮는다. */
  it('줄에 토큰이 아예 없는 browser js 도 같은 문장을 받는다', () => {
    const d = lostAnswerDetails({ argv: ['browser', 'js'], request: 'rq-1', fromStdin: ['script'] })
    expect(Object.hasOwn(d, 'retryCommand')).toBe(false)
    expect(d.retryNote).toContain('--script')
  })

  /** **줄은 실제로 파싱돼야 한다.** 이 저장소는 없는 것을 가리키는 안내를 몇 번 내보냈고, 그래서
   *  여기서는 만든 줄을 도로 파서에 넣어 같은 명령과 같은 인자가 나오는지 본다. */
  it('만든 줄은 도로 파싱돼 같은 명령과 같은 인자가 된다', () => {
    const line = (lostAnswerDetails({ argv, request: 'rq-1' }) as { retryCommand: string }).retryCommand
    const parsed = parseArgs(splitCommandLine(line).slice(1))
    expect(parsed).toMatchObject({
      cmd: 'worker-start',
      args: { task: 'tsk_1', agent: 'codex', requestId: 'rq-1' }
    })
  })

  /** 이미 줄에 있던 `--request-id` 는 값과 함께 걷어 내고 진짜 id 를 붙인다 — 그러지 않으면 같은
   *  플래그가 둘이 되고, `--request-id -` 처럼 값을 stdin 에서 읽은 줄은 다시 stdin 을 읽으려 든다. */
  it('이미 실린 --request-id 는 값과 함께 걷어 내고 다시 붙인다', () => {
    expect(
      retryCommandLine({ argv: ['jobs', 'get', '--id', 'job_1', '--request-id', '-'], request: 'rq-9' })
    ).toBe('astera jobs get --id job_1 --request-id rq-9')
  })

  /** 빈칸이 든 값은 따옴표로 묶는다. 묶지 않으면 그 줄은 다른 명령이 된다 — `--objective 두 낱말` 은
   *  두 번째 낱말에서 `unexpected argument` 로 죽는다. */
  it('빈칸과 따옴표가 든 값은 묶여 나가고, 묶인 채로 도로 파싱된다', () => {
    const line = retryCommandLine({
      argv: ['run-create', '--objective', '두 낱말과 "따옴표"'],
      request: 'rq-1'
    })
    expect(line).toBe(`astera run-create --objective '두 낱말과 "따옴표"' --request-id rq-1`)
    expect(parseArgs(splitCommandLine(line).slice(1))).toMatchObject({
      args: { objective: '두 낱말과 "따옴표"', requestId: 'rq-1' }
    })
  })

  /**
   * **우리는 이 줄을 "그대로 치면 된다" 고 발행한다. 그러니 치는 것이 무엇을 실행해서는 안 된다.**
   *
   * 큰따옴표 안에서 셸은 여전히 `$HOME` 과 `$(…)` 와 역따옴표를 펼친다. 답을 잃은 `ask
   * --question 'ship at $(date)?'` 의 회복 줄을 사람이 붙여 넣으면 `date` 가 돌고, 그러고 나서 인자가
   * 달라졌으니 지문이 400 으로 막는다 — 그것이 **덜 나쁜** 쪽 결말이다.
   *
   * 값은 그대로 돌아오고, 펼칠 자리는 하나도 남지 않아야 한다. 뒤엣것을 앞의 `splitCommandLine` 은
   * 볼 수 없었다 — 이미 파싱된 문자열에 셸의 쪼개기 규칙만 적용했기 때문이다.
   */
  it('펼쳐질 수 있는 것은 하나도 남기지 않는다', () => {
    for (const value of ['ship at $(date)?', 'cost is $HOME', 'tick `whoami` tock', 'a$b']) {
      const line = retryCommandLine({ argv: ['ask', '--question', value], request: 'rq-1' })
      const back = posixArgv(line)
      expect(back.expansions, `${value} 가 펼쳐질 자리를 남겼다`).toEqual([])
      expect(back.argv).toEqual(['astera', 'ask', '--question', value, '--request-id', 'rq-1'])
    }
  })

  /** **win32 이 주 무대이고 경로에는 역슬래시가 있다.** 큰따옴표 안에서 역슬래시를 겹치면 bash 만
   *  그것을 도로 읽고, `CommandLineToArgvW` 는 겹친 그대로 넘긴다. 홑따옴표 안에서는 아무것도 특별하지
   *  않으므로 친 경로가 그대로 간다. */
  it('Windows 경로는 겹치지도 잘리지도 않는다', () => {
    const line = retryCommandLine({
      argv: ['projects', 'find', '--path', 'D:\\repo\\sub'],
      request: 'rq-1'
    })
    expect(line).toBe(`astera projects find --path 'D:\\repo\\sub' --request-id rq-1`)
    expect(posixArgv(line).argv[4]).toBe('D:\\repo\\sub')
  })

  /** 홑따옴표 안에 홑따옴표는 못 쓴다. POSIX 의 관용구로 닫고 벗기고 다시 연다 — 이 줄이 bash·zsh
   *  전용이 되는 유일한 자리이고, 그래서 두 문서가 어느 셸을 겨눈 줄인지 말한다. */
  it('값 안의 홑따옴표는 POSIX 관용구로 나간다', () => {
    const line = retryCommandLine({ argv: ['ask', '--question', "don't stop"], request: 'rq-1' })
    expect(line).toBe(`astera ask --question 'don'\\''t stop' --request-id rq-1`)
    expect(posixArgv(line).argv[3]).toBe("don't stop")
  })

  /**
   * **친 줄과 보낸 부름이 같아야 한다**(`implicitArgs`). `argsForCall` 은 `run-create` 의 빠진
   * `--cwd` 를 이 프로세스의 작업 폴더로 메꾸고, Host 는 그 값까지 지문에 넣는다. 메꾼 것을 안 적으면
   * 다른 폴더에서 친 회복 줄이 "같은 id 를 다른 인자로 썼다" 로 400 을 받는다 — 두 줄이 글자 하나까지
   * 같은데.
   */
  it('이 프로세스가 메꾼 인자는 회복 줄에 적힌다', () => {
    const typed = { objective: 'o' }
    const sent = argsForCall({ cmd: 'run-create', args: typed, cwd: 'D:/where-it-ran' })
    const line = retryCommandLine({
      argv: ['run-create', '--objective', 'o'],
      request: 'rq-1',
      implicit: implicitArgs(typed, sent)
    })
    expect(line).toBe('astera run-create --objective o --cwd D:/where-it-ran --request-id rq-1')
    // 그리고 그 줄을 도로 파싱하면 첫 부름이 보낸 것과 같은 인자가 나온다 — 어느 폴더에서 치든.
    const back = parseArgs(splitCommandLine(line).slice(1))
    expect((back as { args: Record<string, unknown> }).args.cwd).toBe('D:/where-it-ran')
  })

  it('친 --cwd 가 있으면 메꾼 것이 없으므로 줄도 그대로다', () => {
    const typed = { objective: 'o', cwd: 'D:/typed' }
    expect(implicitArgs(typed, argsForCall({ cmd: 'run-create', args: typed, cwd: 'D:/elsewhere' }))).toEqual({})
  })
})

/**
 * **문장 전체를 한 번 돌려 본다**(요청 영수증 설계 §13 단계 10). 답이 사라진 명령이 내보낸
 * `retryCommand` 를 그대로 도로 파싱하고, CLI 가 하는 일(`--request-id` 를 봉투로 옮기는 것)을 하고,
 * 진짜 Host 에 친다 — 나오는 것이 재생이어야 한다.
 *
 * 조각마다 시험이 있어도 이 줄은 조각들 **사이**에서 끊긴다: 따옴표가 파서와 어긋나거나, 걷어 낸
 * 플래그가 인자로 남거나, 새긴 id 가 봉투에 못 오르거나. 이 저장소가 없는 것을 가리키는 안내를
 * 내보낸 적이 있어서, 이 단계만은 끝에서 끝까지 잰다.
 */
describe('회복 줄은 진짜로 재생을 부른다', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-cli-replay-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('답을 잃은 run-create 의 retryCommand 를 도로 쳐서 같은 회차를 받는다', async () => {
    const orch = createHostOrch({
      profileDir: dir,
      version: '9.9.9',
      now: () => '2026-09-23T00:00:00.000Z',
      hostStartedAt: () => '2026-09-22T23:00:00.000Z',
      runningSessions: () => 0,
      aliveSessionIds: () => new Set<string>(),
      act: async (name, callArgs) => (name === 'resolveProjectRoot' ? callArgs[0] : {}),
      hasApp: () => true,
      onState: () => {},
      log: () => {},
      sessions: { listSessions: async () => [], readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }), sendSession: async () => {}, readChat: async () => [], sendChat: async () => {}, serial: (_id, run) => run() }
    })
    // 키를 안 단 부름이고, **`--cwd` 도 안 단 부름이다**(§8, 그리고 `implicitArgs`). 일부러 그렇게
    // 둔다: `argsForCall` 이 메꾼 cwd 는 Host 가 지문에 넣는 값이므로, 회복 줄이 그것을 안 싣고
    // 나가면 다른 폴더에서 다시 친 줄이 400 을 받는다 — 두 줄이 글자까지 같은데.
    const argv = ['run-create', '--objective', '두 낱말']
    const first = parseArgs(argv)
    if ('error' in first) throw new Error(first.error)
    const request = mintRequestId()
    // 두 폴더는 이 플랫폼의 절대 경로다 — 진짜 process.cwd() 가 그렇다. 'D:/…' 는 posix 에서 상대
    // 경로라, 회복 줄에 적힌 --cwd 가 다시 친 폴더에 대해 풀려 다른 인자가 된다.
    const sentArgs = argsForCall({ cmd: first.cmd, args: first.args, cwd: path.resolve('/where-it-ran') })
    const sent = await orch.call({ cmd: first.cmd, args: sentArgs, sessionId: 'sesA', request })
    expect(sent.status).toBe(200)
    // …그리고 그 답이 오는 길에 사라졌다. 부르는 쪽이 손에 쥐는 것은 이 줄뿐이다.
    const line = (
      lostAnswerDetails({ argv, request, implicit: implicitArgs(first.args, sentArgs) }) as {
        retryCommand: string
      }
    ).retryCommand
    const retyped = parseArgs(splitCommandLine(line).slice(1))
    if ('error' in retyped) throw new Error(retyped.error)
    const lifted = liftRequestId(retyped.args)
    if ('error' in lifted) throw new Error(lifted.error)
    // 다시 친 줄은 **다른 폴더에서** 쳐진다 — 그것이 이 시험이 잡으려는 경우다.
    const again = await orch.call({
      cmd: retyped.cmd,
      args: argsForCall({ cmd: retyped.cmd, args: lifted.args, cwd: path.resolve('/somewhere-else') }),
      sessionId: 'sesA',
      request: lifted.request
    })
    expect(again.replayed, '다시 친 줄이 재생이 아니라 새 명령이었다').toBe(true)
    expect((again.body as { id: string }).id).toBe((sent.body as { id: string }).id)
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'orchestration.json'), 'utf8')) as {
      jobs: unknown[]
      runs: unknown[]
    }
    expect(saved.jobs, '다시 친 줄이 계획을 하나 더 만들었다').toHaveLength(1)
    expect(saved.runs).toHaveLength(1)
  })
})

describe('callHost — 명령 하나를 Host 에 묻는다', () => {
  /** `connectHost` 가 돌려주는 것 중 이 함수가 쓰는 것만. 소켓 없이 순서를 재기 위한 것이다. */
  const fakeConn = (): {
    conn: HostConnection
    sent: ClientMessage[]
    answer(m: HostMessage): void
    drop(): void
  } => {
    const sent: ClientMessage[] = []
    const listeners = new Set<(m: HostMessage) => void>()
    const closers = new Set<() => void>()
    return {
      sent,
      answer: (m) => {
        for (const cb of [...listeners]) cb(m)
      },
      drop: () => {
        for (const cb of [...closers]) cb()
      },
      conn: {
        hello: { host: '1', pid: 1, startedAt: 'T', features: ['orch'] },
        call: (m) => sent.push(m),
        onMessage: (cb) => {
          listeners.add(cb)
          return () => listeners.delete(cb)
        },
        onClose: (cb) => {
          closers.add(cb)
          return () => closers.delete(cb)
        },
        close: () => {}
      }
    }
  }

  it('명령과 인자와 세션을 한 줄로 보내고 그 답을 돌려준다', async () => {
    const f = fakeConn()
    const p = callHost({
      conn: f.conn,
      cmd: 'jobs-list',
      args: { limit: 5 },
      sessionId: 'sess_1',
      timeoutMs: 1000
    })
    expect(f.sent[0]).toMatchObject({
      t: 'orch-call',
      cmd: 'jobs-list',
      args: { limit: 5 },
      session: 'sess_1'
    })
    const call = (f.sent[0] as { call: string }).call
    f.answer({ t: 'orch-result', call, status: 200, body: { jobs: [] } })
    expect(await p).toEqual({ status: 200, body: { jobs: [] } })
  })

  // 답은 자기 call 을 이름으로 부른다 — 남의 것을 자기 답으로 읽으면 안 된다.
  it('다른 call 의 답은 자기 답이 아니다', async () => {
    const f = fakeConn()
    const p = callHost({ conn: f.conn, cmd: 'status', args: {}, sessionId: '', timeoutMs: 50 })
    f.answer({ t: 'orch-result', call: 'someone_else', status: 200, body: { running: true } })
    expect(await p).toEqual({ stuck: expect.stringContaining('did not answer status') })
  })

  // 답 전에 끊긴 것은 Host 가 사라진 것이다 — 보고가 파일에 적히는 쪽으로 가야 한다.
  it('답 전에 연결이 끊기면 닿지 못한 것이다', async () => {
    const f = fakeConn()
    const p = callHost({ conn: f.conn, cmd: 'send', args: {}, sessionId: '', timeoutMs: 1000 })
    f.drop()
    expect(await p).toEqual({ unreachable: expect.stringContaining('closed the connection') })
  })

  // 시한을 넘긴 것은 연결은 됐는데 저쪽이 멈춘 것이다 — 그냥 실패이고, 보고를 적어 두지 않는다.
  it('시한을 넘기면 멈춘 것으로 답한다', async () => {
    const f = fakeConn()
    expect(
      await callHost({ conn: f.conn, cmd: 'ask', args: {}, sessionId: '', timeoutMs: 10 })
    ).toEqual({ stuck: expect.stringContaining('within 10ms') })
  })

  // 요청 id 는 `args` 가 아니라 봉투를 탄다 — `call` 은 이 소켓에서의 이 시도를 가리키고,
  // `request` 는 시도를 건너 같은 요청을 가리킨다(설계 §8).
  it('실린 요청 id 는 봉투의 request 칸으로 나간다', () => {
    const f = fakeConn()
    void callHost({
      conn: f.conn,
      cmd: 'run-create',
      args: { objective: 'o' },
      sessionId: 'sess_1',
      request: 'req-1',
      timeoutMs: 1000
    })
    expect(f.sent[0]).toMatchObject({ t: 'orch-call', request: 'req-1', args: { objective: 'o' } })
  })

  // id 를 안 준 것과 빈 것을 저쪽이 가를 수 있어야 한다 — 칸을 만들어 보내면 그 둘이 한 모양이 된다.
  it('id 가 없으면 그 칸을 만들지 않는다', () => {
    const f = fakeConn()
    void callHost({ conn: f.conn, cmd: 'jobs-list', args: {}, sessionId: '', timeoutMs: 1000 })
    expect(Object.hasOwn(f.sent[0], 'request')).toBe(false)
  })

  /**
   * **저쪽이 붙인 낱말을 이쪽이 그대로 들고 온다.** 이 한 걸음이 없으면 `replayed` 는 Host 에서
   * 봉투까지 오지 못하고, 재생된 404 는 첫 404 와 구별되지 않는다. 표시가 없는 보통 답에는 칸을
   * 만들지 않는다 — 있고 `false` 인 것과 애초에 없는 것을 읽는 쪽이 가를 수 있어야 한다.
   */
  it('orch-result 의 재생·관찰 표시를 그대로 들고 온다', async () => {
    const answered = async (extra: Partial<HostMessage & { replayed: true; observed: true }>) => {
      const f = fakeConn()
      const p = callHost({ conn: f.conn, cmd: 'run-create', args: {}, sessionId: '', timeoutMs: 1000 })
      const call = (f.sent[0] as { call: string }).call
      f.answer({ t: 'orch-result', call, status: 404, body: { error: 'nope' }, ...extra } as HostMessage)
      return await p
    }
    expect(await answered({ replayed: true })).toEqual({
      status: 404,
      body: { error: 'nope' },
      replayed: true
    })
    expect(await answered({ observed: true })).toEqual({
      status: 404,
      body: { error: 'nope' },
      observed: true
    })
    const plain = await answered({})
    expect(Object.hasOwn(plain, 'replayed')).toBe(false)
    expect(Object.hasOwn(plain, 'observed')).toBe(false)
  })

  // 끊긴 뒤에 오는 답은 없지만, 두 번 답하는 Host 에 두 번 resolve 되면 안 된다.
  it('한 번만 답한다', async () => {
    const f = fakeConn()
    const p = callHost({ conn: f.conn, cmd: 'status', args: {}, sessionId: '', timeoutMs: 1000 })
    const call = (f.sent[0] as { call: string }).call
    f.answer({ t: 'orch-result', call, status: 200, body: 1 })
    f.answer({ t: 'orch-result', call, status: 500, body: 2 })
    expect(await p).toEqual({ status: 200, body: 1 })
  })
})

// 텍스트 가드. **이 가지에서 `--human` 이 봉투를 찍은 것이 네 번이고, 그때마다 고친 것은 그 자리
// 하나였다** — help 의 두 자리, browser-help 의 두 자리, browser js --file, 그리고 Host 에 닿지
// 못한 자리. 자리를 세는 한 다음에 또 잊는다. 그래서 잊을 수 없는 모양으로 바꾸고(main 의 `fail`),
// 그 모양이 유지되는 것을 여기서 지킨다: 모드가 정해진 뒤로는 봉투를 짓는 호출이 하나도 없어야
// 한다. 새 실패 경로를 더하는 사람이 기본값으로 얻는 것이 모드를 따르는 쪽이 된다.
describe('run.ts — 모드가 정해진 뒤의 실패는 한 문으로만 나간다', () => {
  const runSource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'run.ts'),
    'utf8'
  )

  /** `fail` 이 세워진 자리 아래 전부. 표식이 사라졌으면 조용히 빈 것을 훑는 대신 여기서 던진다. */
  function afterSeam(): string {
    const at = runSource.indexOf('// FAIL_SEAM')
    if (at < 0) throw new Error('run.ts has no FAIL_SEAM marker — did the fail() funnel move?')
    return runSource.slice(at)
  }

  // 실패를 내보내는 세 가지. 성공 쪽은 `renderOk` 한 곳으로 이미 모여 있고, `agent-context` 만
  // 일부러 `okEnvelope` 를 직접 쓴다 — 스키마는 모드와 무관하게 JSON 이다.
  //
  // **이 가드가 무엇을 잡는지 분명히 해 둔다: 사고이지 우회가 아니다.** 한 파일의 글자만 보므로,
  // `main` 위나 다른 모듈에 찍는 함수를 두고 아래에서 부르면 지나가고, `process.stdout.write` 로
  // 직접 써도 지나간다. 그것들은 가드를 알고 돌아가는 일이라 리뷰의 몫이다. 잡으려는 것은 실패
  // 경로를 하나 더 붙이면서 `fail` 을 쓰지 않는, 그럴 법한 실수다.
  it('봉투를 짓는 실패 호출이 하나도 남아 있지 않다', () => {
    for (const call of ['errorOutput(', 'errEnvelope(', 'renderErr('])
      expect(afterSeam().split(call).length - 1, `${call} is called after the seam`).toBe(0)
  })

  // **아무것도 안 찍고 끝내는 것이 이 집안에서 가장 나쁘다.** 봉투를 잘못 찍는 것은 보이기라도
  // 하는데, 맨 `process.exit(2)` 는 스크립트에게 코드만 주고 왜인지는 아무 데도 남기지 않는다.
  // 그래서 0 이 아닌 종료는 전부 `fail` 을 지나야 하고, 지나지 않는 자리는 그 줄에서 그렇게 말해야
  // 한다. 그 수를 센다.
  it('0 이 아닌 종료는 fail 을 지나거나, 그 자리에서 면제라고 말한다', () => {
    const lines = afterSeam().split('\n')
    const exits = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.includes('process.exit('))
    expect(exits.length).toBeGreaterThan(0)
    const bare = exits.filter(({ l }) => !l.includes('process.exit(0)'))
    for (const { l, i } of bare) {
      // 바로 앞의 주석 덩이에 표식이 있으면 된다 — 한 줄짜리 표식을 강요하면 이유를 적을 자리가 없다
      const preface = lines.slice(Math.max(0, i - 8), i).join('\n')
      expect(preface.includes('FAIL_SEAM:exempt'), `unmarked non-zero exit: ${l.trim()}`).toBe(true)
    }
    // 면제는 없다. `host-*` 가 성공 모양의 본문에 0 아닌 코드를 붙이던 것이 마지막 면제였고, 그 실패는
    // 이제 `fail` 을 지난다(리뷰 I1).
    expect(bare.length, 'the number of exemptions changed').toBe(0)
  })

  // 앞선 세 자리는 아직 모드가 없어서 봉투로 나간다 — 그것이 errorOutput 이 남아 있는 이유이고,
  // 그 수가 늘면 모드 뒤의 실패가 앞으로 새어 나온 것이다.
  it('모드 앞의 봉투는 셋뿐이다 — 사용법·파서·모드 자신', () => {
    const before = runSource.slice(0, runSource.indexOf('// FAIL_SEAM'))
    expect(before.split('out(errorOutput(').length - 1).toBe(3)
  })
})

// **긴 기다림이 조용하면 멈춘 Host 와 구별되지 않는다.** 이 저장소는 그 침묵에 한 번 물렸고
// (docs/2026-09-22-host-unresponsive-recovery-design.md), 그래서 기다리는 동안 살아 있다는 줄을
// stderr 에 낸다 — stdout 은 결과 하나뿐이어야 하므로 거기 섞일 수 없다.
describe('startKeepalive — 기다리는 동안 내는 줄', () => {
  let clock = 0
  const now = (): number => clock
  /** 시계와 타이머를 **조금씩 함께** 민다. 한 번에 밀면 그 사이에 오갔어야 할 pong 이 전부
   *  같은 순간에 몰려, 건강한 Host 도 한 간격 내내 조용했던 것으로 읽힌다. */
  const pass = (ms: number): void => {
    for (let i = 0; i < ms; i += 1000) {
      clock += 1000
      vi.advanceTimersByTime(1000)
    }
  }

  /** `answers` 가 이 Host 의 상태다: ping 에 곧바로 pong 하는 Host 와, 받고도 아무 말이 없는
   *  Host — 바로 그 둘을 이 줄이 갈라야 한다. */
  const fakeConn = (
    o: { features: string[]; answers: boolean }
  ): {
    conn: Pick<HostConnection, 'hello' | 'call' | 'onMessage'>
    sent: ClientMessage[]
  } => {
    const sent: ClientMessage[] = []
    const listeners = new Set<(m: HostMessage) => void>()
    return {
      sent,
      conn: {
        hello: { host: '1', pid: 1, startedAt: 'T', features: o.features },
        call: (m) => {
          sent.push(m)
          if (o.answers && m.t === 'ping') for (const cb of [...listeners]) cb({ t: 'pong', seq: m.seq })
        },
        onMessage: (cb) => {
          listeners.add(cb)
          return () => listeners.delete(cb)
        }
      }
    }
  }

  beforeEach(() => {
    clock = 0
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const lines: string[] = []
  const start = (o: {
    cmd: string
    args?: Record<string, unknown>
    enabled?: boolean
    features?: string[]
    answers?: boolean
  }): { conn: ReturnType<typeof fakeConn>; keepalive: { stop: () => void } } => {
    lines.length = 0
    const conn = fakeConn({ features: o.features ?? ['orch', 'ping'], answers: o.answers !== false })
    const keepalive = startKeepalive({
      conn: conn.conn,
      cmd: o.cmd,
      args: o.args ?? {},
      enabled: o.enabled ?? true,
      tickMs: 5_000,
      lineMs: 15_000,
      now,
      write: (l) => lines.push(l)
    })
    return { conn, keepalive }
  }

  // 기다리지 않는 출력에 살아 있다는 줄이 붙으면 그 줄은 아무것도 뜻하지 않게 된다.
  it('기다리지 않는 명령에는 아무것도 내지 않는다', () => {
    const { conn } = start({ cmd: 'jobs-list' })
    pass(60_000)
    expect(lines).toEqual([])
    expect(conn.sent).toEqual([])
  })

  it('--no-keepalive 는 한 줄도 내지 않고 묻지도 않는다', () => {
    const { conn } = start({ cmd: 'runs-wait', enabled: false })
    pass(60_000)
    expect(lines).toEqual([])
    expect(conn.sent).toEqual([])
  })

  it('기다리는 동안 한 줄씩 내고, 답이 오면 멈춘다', () => {
    const { keepalive } = start({ cmd: 'runs-wait' })
    pass(15_000)
    expect(lines).toEqual(['waiting for runs wait, 15s so far; the Host answered 5s ago'])
    pass(15_000)
    expect(lines).toHaveLength(2)
    keepalive.stop()
    pass(60_000)
    expect(lines).toHaveLength(2)
  })

  // 줄보다 자주 묻지 않으면, 건강한 Host 도 언제나 "한 간격 전에 답했다" 가 되어 그 칸이
  // 아무것도 말하지 않는다.
  it('ping 은 줄보다 자주 간다', () => {
    const { conn } = start({ cmd: 'ask' })
    pass(15_000)
    expect(conn.sent).toEqual([
      { t: 'ping', seq: 1 },
      { t: 'ping', seq: 2 },
      { t: 'ping', seq: 3 }
    ])
  })

  // **이 줄이 있는 이유가 "멈춘 Host 인가" 다.** 이쪽이 살아 있다는 것만 찍으면 그 질문에
  // 답하지 못한다.
  it('Host 가 답을 그치면 줄이 그 사실을 말한다', () => {
    const { conn } = start({ cmd: 'ask', answers: false })
    pass(45_000)
    // 받기는 받았다 — 답이 없을 뿐이고, 그것이 이 줄이 말해야 하는 사실이다
    expect(conn.sent).toHaveLength(9)
    expect(lines[0]).toContain('the Host has not answered a ping for 15s')
    expect(lines[2]).toContain('the Host has not answered a ping for 45s')
  })

  // 모르는 메시지를 흘려버리는 Host 에 물으면 답이 영영 오지 않고, 그 침묵은 고장이 아니다
  it('ping 을 모르는 Host 에는 묻지 않고, 아는 척도 하지 않는다', () => {
    const { conn } = start({ cmd: 'check', args: { wait: true }, features: ['orch'], answers: false })
    pass(15_000)
    expect(conn.sent).toEqual([])
    expect(lines).toEqual(['waiting for check, 15s so far'])
  })
})
