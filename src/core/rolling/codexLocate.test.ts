import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findRollout } from './codexLocate'
import { absPath } from '../testPaths'

let home: string
const NOW = Date.parse('2026-07-09T10:00:00Z') // 고정 '현재' — 오늘=2026/07/09, 어제=2026/07/08

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-cxloc-'))
})

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true }) // 실행마다 임시 디렉터리가 쌓이지 않게
})

/** birthtime 해상도(win32 실측 ~1ms)보다 확실히 큰 간격 — 생성 순서를 타임스탬프로 구분한다 */
const gap = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

/** <configDir>/sessions/<y>/<m>/<d>/rollout-...-<uuid>.jsonl 생성 후 mtime 지정.
 *  생성 시각(birthtime)은 조작할 수 없으므로 '실제 지금'이다 — since를 birthtime 기준으로 잡는 테스트는
 *  fs.stat으로 읽어 쓴다. NOW는 스캔할 날짜 폴더만 정한다. */
async function makeRollout(opts: {
  y: string
  m: string
  d: string
  uuid: string
  cwd: string | null
  mtimeMs: number
  /** session_meta.source. 'exec' 는 이 앱이 돌린 일회성 실행이다 */
  source?: string
}): Promise<string> {
  const dir = path.join(home, 'sessions', opts.y, opts.m, opts.d)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `rollout-2026-07-09T00-00-00-${opts.uuid}.jsonl`)
  const meta = {
    type: 'session_meta',
    payload:
      opts.cwd === null
        ? { session_id: opts.uuid }
        : { session_id: opts.uuid, cwd: opts.cwd, ...(opts.source ? { source: opts.source } : {}) }
  }
  await fs.writeFile(file, JSON.stringify(meta) + '\n', 'utf8')
  const t = new Date(opts.mtimeMs)
  await fs.utimes(file, t, t)
  return file
}

describe('findRollout', () => {
  it('spawn 시각 이후 생성되고 cwd가 일치하는 rollout을 찾는다', async () => {
    await makeRollout({
      y: '2026', m: '07', d: '09',
      uuid: '019f4524-e0ac-7571-a8af-5585504f0d32',
      cwd: 'D:\\work\\p',
      mtimeMs: NOW - 1_000
    })
    const r = await findRollout({ configDir: home, cwd: 'D:\\work\\p', since: NOW - 5_000, now: () => NOW })
    expect(r?.sessionId).toBe('019f4524-e0ac-7571-a8af-5585504f0d32')
  })

  it('spawn 시각 이전에 생성된 파일은 무시한다 (이전 세션)', async () => {
    const file = await makeRollout({
      y: '2026', m: '07', d: '09',
      uuid: '019f4524-e0ac-7571-a8af-5585504f0d33',
      cwd: 'D:\\work\\p',
      mtimeMs: NOW - 60_000
    })
    const birth = (await fs.stat(file)).birthtimeMs
    expect(
      await findRollout({ configDir: home, cwd: 'D:\\work\\p', since: birth + 60_000, now: () => NOW })
    ).toBeNull()
  })

  // 리뷰 지적: 같은 계정·같은 cwd에서 이미 돌던 codex 세션(사용자가 터미널에서 띄웠거나
  // 롤링 없는 다른 탭)이 한 턴만 출력해도 mtime이 갱신된다. mtime 기준이면 갓 만들어져 조용한 우리
  // rollout보다 최신이라 체인이 남의 대화를 물어버린다 — 판별 기준은 '새로 생성된' 파일이어야 한다.
  it('이미 있던 파일이 spawn 이후에 갱신돼도 후보가 아니다 (생성 시각 기준)', async () => {
    const file = await makeRollout({
      y: '2026', m: '07', d: '09',
      uuid: '019f4524-e0ac-7571-a8af-5585504f0d45',
      cwd: 'D:\\work\\p',
      mtimeMs: NOW - 60_000
    })
    const since = (await fs.stat(file)).birthtimeMs + 60_000 // 이 파일이 생긴 한참 뒤 우리 세션 spawn
    const touched = new Date(since + 5_000) // 그 뒤 옛 세션이 한 턴 출력 → mtime만 갱신
    await fs.utimes(file, touched, touched)
    expect(
      await findRollout({ configDir: home, cwd: 'D:\\work\\p', since, now: () => NOW })
    ).toBeNull()
  })

  // CLOCK_SKEW_MS(2초)를 아무 테스트도 고정하지 않아 60초로 늘려도 전부 그린이었다.
  // 허용치가 커질수록 '우리 spawn 직전에 생긴 남의 세션'을 물 창이 넓어지므로 상·하한을 함께 잠근다.
  it('생성 시각이 since보다 조금 이른 파일은 클럭 오차로 보고 받아준다', async () => {
    const file = await makeRollout({
      y: '2026', m: '07', d: '09',
      uuid: '019f4524-e0ac-7571-a8af-5585504f0d46',
      cwd: 'D:\\work\\p',
      mtimeMs: NOW - 1_000
    })
    const birth = (await fs.stat(file)).birthtimeMs
    const r = await findRollout({
      configDir: home, cwd: 'D:\\work\\p', since: birth + 1_500, now: () => NOW // 허용치(2초) 안
    })
    expect(r?.sessionId).toBe('019f4524-e0ac-7571-a8af-5585504f0d46')
  })

  it('허용치를 넘게 이른 파일은 받지 않는다 (허용치가 넓어지면 이 테스트가 깨진다)', async () => {
    const file = await makeRollout({
      y: '2026', m: '07', d: '09',
      uuid: '019f4524-e0ac-7571-a8af-5585504f0d47',
      cwd: 'D:\\work\\p',
      mtimeMs: NOW - 1_000
    })
    const birth = (await fs.stat(file)).birthtimeMs
    expect(
      await findRollout({
        configDir: home, cwd: 'D:\\work\\p', since: birth + 5_000, now: () => NOW // 허용치(2초) 밖
      })
    ).toBeNull()
  })

  it('cwd가 다르면 무시한다 (같은 시각 다른 프로젝트 세션)', async () => {
    await makeRollout({
      y: '2026', m: '07', d: '09',
      uuid: '019f4524-e0ac-7571-a8af-5585504f0d34',
      cwd: 'D:\\work\\other',
      mtimeMs: NOW - 1_000
    })
    expect(
      await findRollout({ configDir: home, cwd: 'D:\\work\\p', since: NOW - 5_000, now: () => NOW })
    ).toBeNull()
  })

  it('cwd 비교는 대소문자 차이를 무시한다', async () => {
    await makeRollout({
      y: '2026', m: '07', d: '09',
      uuid: '019f4524-e0ac-7571-a8af-5585504f0d35',
      cwd: absPath('WORK', 'p'),
      mtimeMs: NOW - 1_000
    })
    const r = await findRollout({
      configDir: home, cwd: absPath('work', 'p'), since: NOW - 5_000, now: () => NOW
    })
    expect(r?.sessionId).toBe('019f4524-e0ac-7571-a8af-5585504f0d35')
  })

  // 구분자 무시는 win32에서만 의미가 있다 — POSIX에서 `\`는 이름에 쓸 수 있는 글자다
  it.runIf(process.platform === 'win32')('win32에서는 구분자 차이도 무시한다', async () => {
    await makeRollout({
      y: '2026', m: '07', d: '09',
      uuid: '019f4524-e0ac-7571-a8af-5585504f0d3a',
      cwd: 'd:/WORK/p',
      mtimeMs: NOW - 1_000
    })
    const r = await findRollout({ configDir: home, cwd: 'D:\\work\\p', since: NOW - 5_000, now: () => NOW })
    expect(r?.sessionId).toBe('019f4524-e0ac-7571-a8af-5585504f0d3a')
  })

  it('어제 날짜 폴더도 본다 (자정 경계·타임존 차이)', async () => {
    await makeRollout({
      y: '2026', m: '07', d: '08',
      uuid: '019f4524-e0ac-7571-a8af-5585504f0d36',
      cwd: 'D:\\work\\p',
      mtimeMs: NOW - 1_000
    })
    const r = await findRollout({ configDir: home, cwd: 'D:\\work\\p', since: NOW - 5_000, now: () => NOW })
    expect(r?.sessionId).toBe('019f4524-e0ac-7571-a8af-5585504f0d36')
  })

  it('후보가 여럿이면 가장 나중에 생성된 파일을 고른다 (mtime이 아니라 생성 시각)', async (ctx) => {
    const older = await makeRollout({
      y: '2026', m: '07', d: '09',
      uuid: '019f4524-e0ac-7571-a8af-5585504f0d37',
      cwd: absPath('work', 'p'),
      mtimeMs: NOW - 500 // 먼저 생겼지만 더 최근에 쓰였다 — 정렬 기준이 mtime이면 이쪽이 뽑힌다
    })
    await gap()
    const newer = await makeRollout({
      y: '2026', m: '07', d: '09',
      uuid: '019f4524-e0ac-7571-a8af-5585504f0d38',
      cwd: absPath('work', 'p'),
      mtimeMs: NOW - 3_000
    })
    // 이 테스트가 성립하려면 파일시스템이 두 생성 시각을 구별해 줘야 한다. createdAt은 birthtime이
    // 0이면 mtime으로 물러나므로(codexLocate.ts), 그런 환경에서는 mtime 순서인 d37이 뽑히는 것이
    // 옳은 동작이다 — 제품의 결함이 아니라 이 단언이 물어볼 수 없는 환경이다.
    const [a, b] = [await fs.stat(older), await fs.stat(newer)]
    if (!(a.birthtimeMs > 0 && b.birthtimeMs > a.birthtimeMs))
      return ctx.skip('생성 시각을 구별하지 못하는 파일시스템 (birthtime 미지원 또는 해상도 부족)')

    const since = a.birthtimeMs - 1_000 // 둘 다 후보에 들어오게
    const r = await findRollout({ configDir: home, cwd: absPath('work', 'p'), since, now: () => NOW })
    expect(r?.sessionId).toBe('019f4524-e0ac-7571-a8af-5585504f0d38')
  })

  it('sessions 폴더가 없으면 null (크래시 금지)', async () => {
    expect(
      await findRollout({
        configDir: path.join(home, 'nope'),
        cwd: 'D:\\work\\p',
        since: 0,
        now: () => NOW
      })
    ).toBeNull()
  })

  it('cwd 없는 rollout은 무시한다', async () => {
    await makeRollout({
      y: '2026', m: '07', d: '09',
      uuid: '019f4524-e0ac-7571-a8af-5585504f0d39',
      cwd: null,
      mtimeMs: NOW - 1_000
    })
    expect(
      await findRollout({ configDir: home, cwd: 'D:\\work\\p', since: NOW - 5_000, now: () => NOW })
    ).toBeNull()
  })

  it('excludePaths에 든 파일은 후보에서 제외한다 (롤 직후 복사본 재획득 방지)', async () => {
    const copied = await makeRollout({
      y: '2026', m: '07', d: '09',
      uuid: '019f4524-e0ac-7571-a8af-5585504f0d41',
      cwd: 'D:\\work\\p',
      mtimeMs: NOW - 1_000
    })
    // 제외하지 않으면 정상 후보다 (제외가 실제로 작동하는지 대조)
    expect(
      (await findRollout({ configDir: home, cwd: 'D:\\work\\p', since: NOW - 5_000, now: () => NOW }))
        ?.sessionId
    ).toBe('019f4524-e0ac-7571-a8af-5585504f0d41')
    expect(
      await findRollout({
        configDir: home,
        cwd: 'D:\\work\\p',
        since: NOW - 5_000,
        now: () => NOW,
        excludePaths: [copied]
      })
    ).toBeNull()
  })

  it('excludePaths 비교는 대소문자·구분자 차이를 무시한다', async () => {
    const copied = await makeRollout({
      y: '2026', m: '07', d: '09',
      uuid: '019f4524-e0ac-7571-a8af-5585504f0d42',
      cwd: 'D:\\work\\p',
      mtimeMs: NOW - 1_000
    })
    expect(
      await findRollout({
        configDir: home,
        cwd: 'D:\\work\\p',
        since: NOW - 5_000,
        now: () => NOW,
        excludePaths: [copied.toUpperCase().replace(/\\/g, '/')]
      })
    ).toBeNull()
  })

  it('excludePaths에 없는 새 rollout은 그대로 찾는다', async () => {
    const copied = await makeRollout({
      y: '2026', m: '07', d: '09',
      uuid: '019f4524-e0ac-7571-a8af-5585504f0d43',
      cwd: 'D:\\work\\p',
      mtimeMs: NOW - 3_000
    })
    await makeRollout({
      y: '2026', m: '07', d: '09',
      uuid: '019f4524-e0ac-7571-a8af-5585504f0d44',
      cwd: 'D:\\work\\p',
      mtimeMs: NOW - 500
    })
    const r = await findRollout({
      configDir: home,
      cwd: 'D:\\work\\p',
      since: NOW - 5_000,
      now: () => NOW,
      excludePaths: [copied]
    })
    expect(r?.sessionId).toBe('019f4524-e0ac-7571-a8af-5585504f0d44')
  })

  it('session_meta에 session_id가 없으면 파일명 uuid로 폴백한다', async () => {
    const uuid = '019f4524-e0ac-7571-a8af-5585504f0d40'
    const dir = path.join(home, 'sessions', '2026', '07', '09')
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `rollout-2026-07-09T00-00-00-${uuid}.jsonl`)
    const meta = { type: 'session_meta', payload: { cwd: 'D:\\work\\p' } } // session_id 없음
    await fs.writeFile(file, JSON.stringify(meta) + '\n', 'utf8')
    const t = new Date(NOW - 1_000)
    await fs.utimes(file, t, t)

    const r = await findRollout({ configDir: home, cwd: 'D:\\work\\p', since: NOW - 5_000, now: () => NOW })
    expect(r?.sessionId).toBe(uuid)
  })
})

// 2026-08-31 실측. 설명 생성 에이전트는 `codex exec` 로 **같은 계정·같은 폴더**에서 돌고, 사용자
// 세션이 자기 파일을 찾는 순간보다 나중에 파일을 만든다. 아래 "가장 최근이 이긴다" 규칙이 그대로
// 적용되면 생성 에이전트의 파일이 사용자 세션의 자리를 차지하고, 그 뒤로 그 세션에 대해 읽는
// 모든 것(작업 단위·사용량·한도)이 엉뚱한 파일을 본다. 실제로 작업 단위 하나가 설명 프롬프트의
// 첫 줄을 제목으로 달고 나타났다.
describe('exec rollout 은 세션의 파일이 아니다', () => {
  const CWD = 'D:\\work\\p'

  it('더 최근이어도 exec 파일은 고르지 않는다', async () => {
    await makeRollout({
      y: '2026', m: '07', d: '09',
      uuid: '019f4524-e0ac-7571-a8af-5585504f0d32',
      cwd: CWD,
      mtimeMs: NOW - 3_000
    })
    await makeRollout({
      y: '2026', m: '07', d: '09',
      uuid: '019f4524-e0ac-7571-a8af-5585504f0d99',
      cwd: CWD,
      mtimeMs: NOW - 1_000, // 더 최근 — 이것이 이기면 안 된다
      source: 'exec'
    })
    const r = await findRollout({ configDir: home, cwd: CWD, since: NOW - 5_000, now: () => NOW })
    expect(r?.sessionId).toBe('019f4524-e0ac-7571-a8af-5585504f0d32')
  })

  it('후보가 exec 뿐이면 아무것도 찾지 못한다 — 남의 파일을 쥐느니 없는 편이 낫다', async () => {
    await makeRollout({
      y: '2026', m: '07', d: '09',
      uuid: '019f4524-e0ac-7571-a8af-5585504f0d77',
      cwd: CWD,
      mtimeMs: NOW - 1_000,
      source: 'exec'
    })
    expect(await findRollout({ configDir: home, cwd: CWD, since: NOW - 5_000, now: () => NOW })).toBeNull()
  })

  // 옛 codex 는 이 필드를 쓰지 않는다. 모를 때 거르면 진짜 세션의 추적이 통째로 죽는다 —
  // 줄 하나가 더 보이는 것보다 훨씬 비싸다
  it('source 가 없는 파일은 그대로 후보다', async () => {
    await makeRollout({
      y: '2026', m: '07', d: '09',
      uuid: '019f4524-e0ac-7571-a8af-5585504f0d55',
      cwd: CWD,
      mtimeMs: NOW - 1_000
    })
    const r = await findRollout({ configDir: home, cwd: CWD, since: NOW - 5_000, now: () => NOW })
    expect(r?.sessionId).toBe('019f4524-e0ac-7571-a8af-5585504f0d55')
  })

  it("사용자가 연 세션(source: 'cli')은 당연히 후보다", async () => {
    await makeRollout({
      y: '2026', m: '07', d: '09',
      uuid: '019f4524-e0ac-7571-a8af-5585504f0d66',
      cwd: CWD,
      mtimeMs: NOW - 1_000,
      source: 'cli'
    })
    const r = await findRollout({ configDir: home, cwd: CWD, since: NOW - 5_000, now: () => NOW })
    expect(r?.sessionId).toBe('019f4524-e0ac-7571-a8af-5585504f0d66')
  })
})
