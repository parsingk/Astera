import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CodexLimitScanner,
  CodexModelChoiceScanner,
  CodexRolloutTail,
  findKeepModelChoice,
  limitReached,
  maxedOut,
  priorBlockAt,
  priorLimitVerdict,
  rolloutSize,
  worstResetAt,
  type CodexLimitState
} from './codexSignal'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-cxsig-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }) // 실행마다 임시 디렉터리가 쌓이지 않게
})

/** 실측 형태를 그대로 본뜬 token_count 줄 */
function tokenCount(opts: {
  primary?: number
  secondary?: number
  primaryReset?: number // epoch 초
  secondaryReset?: number
  reached?: string | null
}): string {
  return JSON.stringify({
    timestamp: '2026-07-09T04:32:12.064Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { total_tokens: 100 } },
      // payload 바로 아래다 — payload.info 안이 아니다 (MEASURED_TOKEN_COUNT 위 주석의 실측 근거)
      rate_limits: {
        limit_id: 'codex',
        limit_name: null,
        primary:
          opts.primary === undefined
            ? null
            : { used_percent: opts.primary, window_minutes: 300, resets_at: opts.primaryReset ?? 1783589526 },
        secondary:
          opts.secondary === undefined
            ? null
            : { used_percent: opts.secondary, window_minutes: 10080, resets_at: opts.secondaryReset ?? 1784075012 },
        credits: null,
        individual_limit: null,
        plan_type: 'plus',
        rate_limit_reached_type: opts.reached ?? null
      }
    }
  })
}

// 한도가 났을 때 실제로 나오는 유일한 구조 신호. 실측 메시지 그대로이며, 접합해 둔 이유는 이 파일이
// 롤링 세션 화면으로 흘렀을 때 CodexLimitScanner 가 물지 않게 하기 위해서다(아래 HIT 와 같은 처방).
const LIMIT_MESSAGE =
  "You've hit your " +
  'usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit ' +
  'https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 7:17 PM.'

/** 턴이 한도로 끝났을 때의 task_complete 줄 (실측 형태) */
const taskComplete = (opts: { timestamp?: string; info?: string | null } = {}): string =>
  JSON.stringify({
    timestamp: opts.timestamp ?? '2026-08-26T08:31:22.224Z',
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: '01a03d31-f058-7880-bb3f-95e64248af91',
      last_agent_message: null,
      error:
        opts.info === null
          ? null
          : { message: LIMIT_MESSAGE, codex_error_info: opts.info ?? 'usage_limit_exceeded' }
    }
  })

const noise = JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'reasoning' } })

async function write(name: string, lines: string[]): Promise<string> {
  const p = path.join(dir, name)
  await fs.writeFile(p, lines.join('\n') + '\n', 'utf8')
  return p
}

// rollout 에서 그대로 떠 온 줄(URL·토큰 수치만 줄임). rate_limits 는 payload.info 안이 아니라
// **payload 바로 아래**에 있다 — 로컬 rollout 108개(codex 0.142.5~0.149.1)에서
// payload.rate_limits 1338건, payload.info.rate_limits 0건이었다.
const MEASURED_TOKEN_COUNT = JSON.stringify({
  timestamp: '2026-08-26T07:41:29.596Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { total_token_usage: { total_tokens: 8696910 }, model_context_window: 258400 },
    rate_limits: {
      limit_id: 'codex',
      limit_name: null,
      primary: { used_percent: 99.0, window_minutes: 300, resets_at: 1787739458 },
      secondary: { used_percent: 15.0, window_minutes: 10080, resets_at: 1788326258 },
      credits: { has_credits: false, unlimited: false, balance: '0' },
      individual_limit: null,
      plan_type: 'plus',
      rate_limit_reached_type: null
    }
  }
})

describe('CodexRolloutTail', () => {
  // 실측 형태를 그대로 넣는 회귀 테스트. 이 자리를 잘못 짚고 있던 동안 rate_limits 는 늘 null 이었고,
  // 그 결과 판정 ①·②·③ 이 전부 죽어 있었다(limitReached 는 state 가 null 이면 문구도 무시한다).
  it('실측 rollout 줄에서 rate_limits를 읽는다 (payload 바로 아래)', async () => {
    const p = await write('measured.jsonl', [MEASURED_TOKEN_COUNT])
    const state = await new CodexRolloutTail(p).read()
    expect(state?.primary).toEqual({ usedPercent: 99, resetsAt: 1787739458_000 })
    expect(state?.secondary?.usedPercent).toBe(15)
  })

  it('마지막 token_count의 rate_limits를 읽고 resets_at을 epoch ms로 정규화한다', async () => {
    const p = await write('a.jsonl', [
      noise,
      tokenCount({ primary: 1, secondary: 7 }),
      tokenCount({ primary: 42, secondary: 9, primaryReset: 1783589526 })
    ])
    const state = await new CodexRolloutTail(p).read()
    expect(state?.primary).toEqual({ usedPercent: 42, resetsAt: 1783589526_000 })
    expect(state?.secondary?.usedPercent).toBe(9)
    expect(state?.reachedType).toBeNull()
  })

  it('두 번째 read는 새로 덧붙은 줄만 읽는다 (오프셋 tail)', async () => {
    const p = await write('b.jsonl', [tokenCount({ primary: 10 })])
    const tail = new CodexRolloutTail(p)
    expect((await tail.read())?.primary?.usedPercent).toBe(10)
    // 새 줄이 없으면 직전 상태를 유지해 돌려준다
    expect((await tail.read())?.primary?.usedPercent).toBe(10)
    await fs.appendFile(p, tokenCount({ primary: 88 }) + '\n', 'utf8')
    expect((await tail.read())?.primary?.usedPercent).toBe(88)
  })

  it('token_count가 하나도 없으면 null', async () => {
    const p = await write('c.jsonl', [noise, noise])
    expect(await new CodexRolloutTail(p).read()).toBeNull()
  })

  it('깨진 줄은 건너뛰고 파일이 없으면 null (크래시 금지)', async () => {
    const p = await write('d.jsonl', ['{broken', tokenCount({ primary: 5 })])
    expect((await new CodexRolloutTail(p).read())?.primary?.usedPercent).toBe(5)
    expect(await new CodexRolloutTail(path.join(dir, 'nope.jsonl')).read()).toBeNull()
  })

  // codex 0.149.1 실측: `codex resume <id>` 는 새 rollout 을 만들지 않고 **기존 파일에 이어 쓴다**.
  // 재개된 세션이 그 파일에 붙을 때 이전 대화가 남긴 rate_limits 까지 읽으면, 지난 한도 스냅숏
  // (reachedType 이 박힌)을 이 세션의 판정으로 오해해 붙자마자 롤한다.
  it('startAtEnd면 붙기 전에 이미 있던 rate_limits는 읽지 않는다 (resume이 이어 쓰는 rollout)', async () => {
    const p = await write('f.jsonl', [tokenCount({ primary: 99, reached: 'primary' })])
    const tail = new CodexRolloutTail(p, Date.now, { startAtEnd: true })
    expect(await tail.read()).toBeNull() // 이전 대화의 스냅숏은 이 세션의 것이 아니다
    await fs.appendFile(p, tokenCount({ primary: 12 }) + '\n', 'utf8')
    expect((await tail.read())?.primary?.usedPercent).toBe(12) // 붙은 뒤 쓰인 것만 읽는다
  })

  // 실측: rate_limit_reached_type 은 로컬 rollout 1288건 전부 null 이다 — 한도가 난 순간에도.
  // 0.149 가 한도를 알려 주는 유일한 구조 신호가 이 task_complete 의 codex_error_info 다.
  it('task_complete의 usage_limit_exceeded를 한도 신호로 읽는다', async () => {
    const p = await write('err.jsonl', [tokenCount({ primary: 40 }), taskComplete()])
    const s = await new CodexRolloutTail(p).read()
    expect(s?.error?.at).toBe(Date.parse('2026-08-26T08:31:22.224Z')) // 판정은 배치 시각이 아니라 기록 자신의 시각에 붙는다
    expect(limitReached(s, { textHit: false })).toBe(true)
  })

  it('한도가 아닌 task_complete는 신호가 아니다', async () => {
    const p = await write('ok.jsonl', [tokenCount({ primary: 40 }), taskComplete({ info: null })])
    const s = await new CodexRolloutTail(p).read()
    expect(s?.error).toBeNull()
    expect(limitReached(s, { textHit: false })).toBe(false)
  })

  // 실측: 한도가 난 0.8초 뒤 codex 는 창이 전부 null 인 크레딧 기록(limit_id "premium")을 내보낸다.
  // 마지막 기록을 통째로 취하면 방금 알아낸 리셋 시각이 지워져, 15분 눈감기 재시도로 떨어진다.
  it('창 없는 기록이 뒤따라도 마지막으로 알던 창을 유지한다 (한도 직후의 크레딧 기록)', async () => {
    const p = await write('keep.jsonl', [
      tokenCount({ primary: 99, primaryReset: 1787739458 }),
      tokenCount({}) // 창이 전부 null — 크레딧 기록
    ])
    const s = await new CodexRolloutTail(p).read()
    expect(s?.primary?.usedPercent).toBe(99)
    expect(worstResetAt(s).at).toBe(1787739458_000)
  })

  it('창은 read를 건너서도 유지된다 (틱이 갈리면 두 기록이 다른 배치에 들어온다)', async () => {
    const p = await write('keep2.jsonl', [tokenCount({ primary: 99, primaryReset: 1787739458 })])
    const tail = new CodexRolloutTail(p)
    expect((await tail.read())?.primary?.usedPercent).toBe(99)
    await fs.appendFile(p, tokenCount({}) + '\n', 'utf8') // 다음 틱에 크레딧 기록만 도착
    const s = await tail.read()
    expect(s?.primary?.usedPercent).toBe(99)
    expect(worstResetAt(s).at).toBe(1787739458_000)
  })

  // 재개 세션의 딜레마: 리셋 시각을 실은 창 기록은 **붙기 전에** 쓰였고, 붙은 뒤 오는 것은 창이 없는
  // 크레딧 기록뿐이다(실측). 그래서 붙는 시점에 파일 뒷부분에서 리셋 시각만 회수한다 — 사용률은
  // 회수하지 않는다. 리셋 전에 찍힌 100% 를 되살리면 폴백 판정 ③(100%+30초 침묵)이 멀쩡한 세션을 롤한다.
  it('startAtEnd로 붙어도 이전 턴의 리셋 시각은 회수한다 (사용률은 회수하지 않는다)', async () => {
    const p = await write('seed.jsonl', [tokenCount({ primary: 100, primaryReset: 1787739458 })])
    const tail = new CodexRolloutTail(p, Date.now, { startAtEnd: true })
    expect(await tail.read()).toBeNull() // 붙은 시점 이전 내용은 상태가 되지 않는다
    await fs.appendFile(p, taskComplete() + '\n', 'utf8') // 재개하자마자 다시 한도
    const s = await tail.read()
    expect(limitReached(s, { textHit: false })).toBe(true)
    expect(worstResetAt(s).at).toBe(1787739458_000) // 리셋은 회수했다
    expect(maxedOut(s)).toBe(false) // 낡은 100%는 판정에 쓰이지 않는다
  })

  it('회수할 리셋이 없으면 at=null 그대로 (없는 시각을 지어내지 않는다)', async () => {
    const p = await write('seed-none.jsonl', [tokenCount({ primary: 40 })]) // 게이트 미만
    const tail = new CodexRolloutTail(p, Date.now, { startAtEnd: true })
    expect(await tail.read()).toBeNull()
    await fs.appendFile(p, taskComplete() + '\n', 'utf8')
    expect(worstResetAt(await tail.read()).at).toBeNull()
  })

  it('파일이 잘리면(재생성) 오프셋을 리셋해 처음부터 다시 읽는다', async () => {
    const p = await write('e.jsonl', [tokenCount({ primary: 70 }), tokenCount({ primary: 71 })])
    const tail = new CodexRolloutTail(p)
    expect((await tail.read())?.primary?.usedPercent).toBe(71)
    await fs.writeFile(p, tokenCount({ primary: 3 }) + '\n', 'utf8') // 더 짧아짐
    expect((await tail.read())?.primary?.usedPercent).toBe(3)
  })
})

describe('CodexLimitScanner', () => {
  it('청크 경계로 잘린 문구도 꼬리를 이어 감지한다', () => {
    const s = new CodexLimitScanner()
    expect(s.push("You've hit your usa")).toBe(false)
    expect(s.push('ge limit. Upgrade to Plus to continue')).toBe(true)
  })

  it('매치 후 버퍼를 비워 같은 문구를 반복 매치하지 않는다', () => {
    const s = new CodexLimitScanner()
    expect(s.push('Usage limit' + ' reached\n')).toBe(true)
    expect(s.push('그 뒤 이어지는 평범한 출력\n')).toBe(false)
  })

  it('ANSI 시퀀스가 단어 사이에 껴도 감지한다', () => {
    const ansi = '[31m'
    const reset = '[0m'
    expect(new CodexLimitScanner().push("You've hit your " + ansi + 'usage' + reset + ' limit.')).toBe(true)
  })

  it('관계없는 출력은 매치하지 않는다', () => {
    expect(new CodexLimitScanner().push('const limit = 10')).toBe(false)
  })

  // codex 0.146.0에서 관찰한 문구.
  // 접합 필수 — 통짜면 이 파일이 롤링 세션의 화면으로 흐를 때 CodexLimitScanner가 물어 실제 롤을
  // 유발한다. 제목에 문구를 보간하지 않는 것(%s가 라벨을 받는 것)도 같은 이유다: 소스를 쪼개도
  // vitest가 출력하는 테스트 제목은 런타임에 합쳐진 통짜라 그 출력이 다시 트리거가 된다 —
  // 실측 오탐 하나가 정확히 이 경로였다.
  const HIT = "You've hit your "
  it.each([
    ['모델 지정', HIT + 'usage limit for gpt-5. Switch to another model now'],
    ['admin 요청', HIT + 'usage limit. To get more access now, send a request to your admin'],
    [
      '크레딧 구매',
      HIT + 'usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits'
    ],
    ['Plus 업그레이드', HIT + 'usage limit. Upgrade to Plus to continue'],
    ['reached 형태', 'Usage limit' + ' reached. Request a limit increase from your owner to continue'],
    ['reached your 형태', "You've reached your " + 'usage limit. Increase your limit to continue']
  ])('실측 한도 문구를 감지한다: %s', (_label, line) => {
    expect(new CodexLimitScanner().push(line)).toBe(true)
  })

  // 좁히기 전 정규식 /(usage|rate)\s+limit/i 이 오탐하던 것들
  it.each([
    'Rate limits',
    'Your rate limit resets in 3h 12m',
    'const RATE_LIMIT_MS = 1000 // usage limit guard'
  ])('한도 도달이 아닌 출력은 매치하지 않는다: %s', (line) => {
    expect(new CodexLimitScanner().push(line)).toBe(false)
  })
})

describe('findKeepModelChoice', () => {
  // codex 0.149.1 화면 그대로. 크레딧이 얼마 안 남으면 턴 사이에 끼어들어 입력을 기다린다 —
  // 답하지 않으면 세션이 그 자리에서 멈춘다(무인 워커에게는 영구 정지다).
  // 머리말은 접합한다 — 통짜면 이 파일이 롤링 세션 화면으로 흘렀을 때 스캐너가 물어 세션에
  // 실제로 '2'와 Enter를 쓴다 (repoSelfTrigger.test.ts 가 저장소 전체를 이 스캐너로 훑는다).
  const APPROACHING = '  Approaching rate ' + 'limits'
  const SCREEN = [
    APPROACHING,
    '  Switch to gpt-5.6-luna for lower credit usage?',
    '',
    '  1. Switch to gpt-5.6-luna              Fast and affordable agentic coding model.',
    '❯ 2. Keep current model',
    '  3. Keep current model (never show again)   Hide future rate limit reminders about switching models.',
    '',
    '  Press enter to confirm or esc to go back'
  ].join('\n')

  it('현재 모델 유지 항목의 번호를 찾는다', () => {
    expect(findKeepModelChoice(SCREEN)).toBe(2)
  })

  // 3번은 codex 설정을 영구히 바꾼다 — 사용자가 요청한 적 없는 변경이므로 고르지 않는다.
  // 2번이 없으면 아무것도 누르지 않고 사용자에게 남긴다.
  it("'never show again' 항목만 있으면 아무것도 고르지 않는다", () => {
    const without2 = SCREEN.split('\n')
      .filter((l) => !l.includes('❯ 2.'))
      .join('\n')
    expect(findKeepModelChoice(without2)).toBeNull()
  })

  it('경고 머리말이 없으면 무시한다 (평범한 출력의 오탐 방지)', () => {
    expect(findKeepModelChoice('2. Keep current model')).toBeNull()
  })

  it('번호 없는 렌더링이면 null (커서 위치를 알 수 없어 아무것도 누르지 않는다)', () => {
    expect(findKeepModelChoice('Approaching rate ' + 'limits\n  Keep current model')).toBeNull()
  })
})

describe('CodexModelChoiceScanner', () => {
  const CHUNK_A = 'Approaching rate ' + 'limits\n  1. Switch to gpt-5.6-luna\n❯ 2. Keep cur'
  const CHUNK_B = 'rent model\n  Press enter to confirm or esc to go back\n'

  it('청크 경계로 쪼개져 와도 번호를 찾는다', () => {
    const s = new CodexModelChoiceScanner()
    expect(s.push(CHUNK_A)).toBeNull()
    expect(s.push(CHUNK_B)).toBe(2)
  })

  it('한 번 답한 화면을 반복해서 답하지 않는다', () => {
    const s = new CodexModelChoiceScanner()
    expect(s.push(CHUNK_A + CHUNK_B)).toBe(2)
    expect(s.push('그 뒤 이어지는 평범한 출력\n')).toBeNull()
  })

  it('번호를 못 찾아 응답하지 못한 프롬프트는 pending 으로 남는다', () => {
    const s = new CodexModelChoiceScanner()
    expect(s.push(CHUNK_A)).toBeNull()
    expect(s.pending()).toBe(true)
  })

  it('응답한 프롬프트는 pending 이 아니다', () => {
    const s = new CodexModelChoiceScanner()
    expect(s.push(CHUNK_A)).toBeNull()
    expect(s.push(CHUNK_B)).toBe(2) // 응답과 함께 tail 이 비워진다
    expect(s.pending()).toBe(false)
  })
})

const state = (o: Partial<CodexLimitState>): CodexLimitState => ({
  primary: null,
  secondary: null,
  reachedType: null,
  error: null,
  priorReset: null,
  at: 1_000,
  ...o
})

describe('limitReached', () => {
  it('① reachedType이 non-null이면 문구 없이도 도달로 본다', () => {
    expect(limitReached(state({ reachedType: 'primary' }), { textHit: false })).toBe(true)
  })

  it('① 한도 에러가 있으면 문구 없이도 도달로 본다 (0.149가 실제로 내보내는 신호)', () => {
    const s = state({ error: { message: LIMIT_MESSAGE, at: 2_000 } })
    expect(limitReached(s, { textHit: false })).toBe(true)
  })

  it('② 확정 문구가 오면 사용률과 무관하게 도달로 본다', () => {
    const s = state({ primary: { usedPercent: 93, resetsAt: null } })
    expect(limitReached(s, { textHit: true })).toBe(true)
  })

  // rate_limits는 턴이 완료돼야 갱신된다. 한도로 요청이 거부되면 새 token_count가
  // 안 나와 사용률이 낮은 값에 멈추는데, 예전 90% 게이트는 그때 정당한 한도 문구를 막아버렸다.
  it('② 사용률 스냅샷이 낮은 값에 멈춰 있어도 확정 문구면 도달로 본다', () => {
    const s = state({
      primary: { usedPercent: 42, resetsAt: null },
      secondary: { usedPercent: 7, resetsAt: null }
    })
    expect(limitReached(s, { textHit: true })).toBe(true)
  })

  it('문구가 없고 reachedType도 없으면 사용률이 높아도 도달이 아니다 (③은 별도 판정)', () => {
    const s = state({ primary: { usedPercent: 99, resetsAt: null } })
    expect(limitReached(s, { textHit: false })).toBe(false)
  })

  // 상태가 없다 = rollout 미매핑. 롤은 rolloutPath·codexSessionId가 있어야 하므로 코디네이터가
  // 별도로 막지만, 판정 자체도 문구만으로 도달을 선언하지 않는다.
  it('상태가 없으면 문구만으로는 도달로 보지 않는다', () => {
    expect(limitReached(null, { textHit: true })).toBe(false)
  })
})

describe('maxedOut', () => {
  it('창 하나라도 100% 이상이면 true', () => {
    expect(maxedOut(state({ secondary: { usedPercent: 100, resetsAt: null } }))).toBe(true)
    expect(maxedOut(state({ primary: { usedPercent: 99, resetsAt: null } }))).toBe(false)
    expect(maxedOut(null)).toBe(false)
  })
})

describe('worstResetAt', () => {
  it('게이트 이상인 창들의 reset 중 가장 늦은 것과 weekly 여부를 돌려준다', () => {
    const s = state({
      primary: { usedPercent: 95, resetsAt: 5_000 },
      secondary: { usedPercent: 97, resetsAt: 9_000 }
    })
    expect(worstResetAt(s)).toEqual({ at: 9_000, weekly: true })
  })

  it('게이트 미만 창은 제외한다', () => {
    const s = state({
      primary: { usedPercent: 95, resetsAt: 5_000 },
      secondary: { usedPercent: 10, resetsAt: 9_000 }
    })
    expect(worstResetAt(s)).toEqual({ at: 5_000, weekly: false })
  })

  it('해당 창이 없으면 at=null', () => {
    expect(worstResetAt(state({}))).toEqual({ at: null, weekly: false })
    expect(worstResetAt(null)).toEqual({ at: null, weekly: false })
  })
})

// worstResetAt 의 게이트는 90 이므로 "리셋이 회수된다"와 "막힌 채 끝났다"는 다른 질문이다. 91% 는
// 바쁘던 대화지 막힌 대화가 아닌데 리셋을 돌려준다 — 그것을 재개 판정의 근거로 쓰면 문구 한 줄 없이
// 멀쩡한 세션이 대기에 처박힌다. 그래서 이쪽은 거부된 턴의 구조 기록을 요구한다.
describe('priorBlockAt', () => {
  it('구조 에러가 있으면 같은 파싱의 리셋을 돌려준다', async () => {
    const p = await write('pb-hit.jsonl', [
      tokenCount({ primary: 99, primaryReset: 1787739458 }),
      taskComplete()
    ])
    expect(await priorBlockAt(p)).toEqual({ at: 1787739458_000, weekly: false })
  })

  // 같은 파일을 느슨한 쪽으로 읽으면 리셋이 회수된다 — 위 'startAtEnd로 붙어도 이전 턴의 리셋
  // 시각은 회수한다' 가 그 성질을 지킨다. 두 질문이 갈리는 지점이 바로 이 픽스처다.
  it('사용률이 게이트를 넘어도 구조 기록이 없으면 null (바쁘던 대화)', async () => {
    const p = await write('pb-busy.jsonl', [tokenCount({ primary: 91, primaryReset: 1787739458 })])
    expect(await priorBlockAt(p)).toBeNull()
  })

  it('reachedType 만 있어도 인정한다 (실측된 적 없지만 다루는 신호)', async () => {
    const p = await write('pb-reached.jsonl', [
      tokenCount({ primary: 99, primaryReset: 1787739458, reached: 'primary' })
    ])
    expect(await priorBlockAt(p)).toEqual({ at: 1787739458_000, weekly: false })
  })

  it('막힌 채 끝났어도 리셋을 못 읽으면 null (없는 시각을 지어내지 않는다)', async () => {
    const p = await write('pb-noreset.jsonl', [tokenCount({ primary: 40 }), taskComplete()])
    expect(await priorBlockAt(p)).toBeNull()
  })

  it('한도 기록이 아닌 종료(error: null)는 차단이 아니다', async () => {
    const p = await write('pb-clean.jsonl', [
      tokenCount({ primary: 99, primaryReset: 1787739458 }),
      taskComplete({ info: null })
    ])
    expect(await priorBlockAt(p)).toBeNull()
  })

  it('파일이 없으면 null', async () => {
    expect(await priorBlockAt(path.join(dir, 'nope.jsonl'))).toBeNull()
  })
})

describe('priorLimitVerdict', () => {
  const NOW = 1_000_000

  it('복구된 리셋이 미래면 문구 없이도 한도다', () => {
    expect(priorLimitVerdict({ at: NOW + 60_000, weekly: false }, { textHit: false }, NOW)).toEqual({
      kind: 'limited',
      at: NOW + 60_000,
      weekly: false
    })
  })

  it('복구된 리셋이 과거면 문구는 재생이다', () => {
    expect(priorLimitVerdict({ at: NOW - 1, weekly: false }, { textHit: true }, NOW)).toEqual({
      kind: 'replay'
    })
  })

  it('복구된 리셋이 과거이고 문구도 없으면 아무것도 아니다', () => {
    expect(priorLimitVerdict({ at: NOW - 1, weekly: false }, { textHit: false }, NOW)).toEqual({
      kind: 'none'
    })
  })

  it('복구된 리셋이 없고 문구가 있으면 한도다 — 리셋 시각은 모른다', () => {
    expect(priorLimitVerdict(null, { textHit: true }, NOW)).toEqual({ kind: 'limited', at: null, weekly: false })
  })

  it('복구된 리셋도 문구도 없으면 아무것도 아니다', () => {
    expect(priorLimitVerdict(null, { textHit: false }, NOW)).toEqual({ kind: 'none' })
  })

  it('리셋 시각이 정확히 지금이면 지난 것으로 본다 (경계)', () => {
    // pickAvailable·blockedUntil 과 같은 관례 — `<= now` 는 만료다
    expect(priorLimitVerdict({ at: NOW, weekly: false }, { textHit: true }, NOW)).toEqual({ kind: 'replay' })
  })

  it('주간 한도면 그 표시가 함께 나온다', () => {
    expect(priorLimitVerdict({ at: NOW + 1, weekly: true }, { textHit: false }, NOW)).toEqual({
      kind: 'limited',
      at: NOW + 1,
      weekly: true
    })
  })
})

describe('rolloutSize', () => {
  // 제자리 재개가 턴을 만들었는지 판정하는 근거다(codexRolling.ts 의 settleInPlace). 크기를 못 읽는
  // 것과 자라지 않은 것을 부르는 쪽이 같게 다루므로, 못 읽을 때 던지지 않고 null 을 내는 것이 계약이다.
  it('파일 크기를 바이트로 돌린다', async () => {
    const p = await write('size.jsonl', [tokenCount({ primary: 1 })])
    const bytes = await rolloutSize(p)
    expect(bytes).toBe((await fs.stat(p)).size)
  })

  it('없는 파일은 던지지 않고 null 이다', async () => {
    expect(await rolloutSize(path.join(dir, 'nope.jsonl'))).toBeNull()
  })
})
