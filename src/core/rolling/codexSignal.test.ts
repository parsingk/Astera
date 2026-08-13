import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CodexLimitScanner,
  CodexRolloutTail,
  limitReached,
  maxedOut,
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
      info: {
        total_token_usage: { total_tokens: 100 },
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
    }
  })
}

const noise = JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'reasoning' } })

async function write(name: string, lines: string[]): Promise<string> {
  const p = path.join(dir, name)
  await fs.writeFile(p, lines.join('\n') + '\n', 'utf8')
  return p
}

describe('CodexRolloutTail', () => {
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

const state = (o: Partial<CodexLimitState>): CodexLimitState => ({
  primary: null,
  secondary: null,
  reachedType: null,
  at: 1_000,
  ...o
})

describe('limitReached', () => {
  it('① reachedType이 non-null이면 문구 없이도 도달로 본다', () => {
    expect(limitReached(state({ reachedType: 'primary' }), { textHit: false })).toBe(true)
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
