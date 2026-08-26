import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readGitSummary } from './gitSummary'
import { git, type GitResult } from '../core/worktrees/git'

// git.test.ts(src/core/worktrees)의 makeRepo와 같은 문제를 겪는다 — 전역 user.email/user.name에
// 기대면 CI/새 머신에서 커밋이 실패한다. 그래서 매 저장소마다 로컬 config를 직접 심는다.
let dir: string
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** git의 stderr를 에러 메시지에 실어, 실패 시 원인을 남긴다(git.test.ts의 run() 관례와 동일). */
function run(cwd: string, args: string[]): void {
  try {
    execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' })
  } catch (err) {
    const e = err as { stderr?: Buffer | string; status?: number }
    throw new Error(
      `git ${args.join(' ')} failed (exit ${e.status ?? '?'}) in ${cwd}\nstderr: ${
        e.stderr ? String(e.stderr).trim() : '(empty)'
      }`
    )
  }
}

/** 커밋 1개짜리 임시 repo. 전역 git 설정에 기대지 않도록 로컬 identity를 심는다. */
async function makeRepo(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-gitsummary-'))
  run(d, ['init', '-b', 'main'])
  run(d, ['config', 'user.email', 't@t.com'])
  run(d, ['config', 'user.name', 'Test User'])
  await fs.writeFile(path.join(d, 'f.txt'), 'x\n', 'utf8')
  run(d, ['add', 'f.txt'])
  run(d, ['commit', '-m', 'init'])
  return d
}

/** fix round 1 — Finding 1: 실제 git으로는 "exit 실패인데 stdout에 내용이 남는" 상태를 안정적으로
 *  재현할 방법이 없다. readGitSummary의 필드 단위 가드(`ok && ...`)가 실제로 그 partial stdout을
 *  버리는지 확인하려면 git 자체를 이중체로 바꿔치기해야 한다 — 그래서 DI를 추가했다(GitSummaryDeps).
 *  네 호출 중 지정한 것만 overrides로 갈아끼우고 나머지는 정상값을 돌려주는 정직한 성공 상태다. */
function fakeGit(overrides: Record<string, GitResult>): typeof git {
  const defaults: Record<string, GitResult> = {
    'rev-parse HEAD': { ok: true, stdout: 'abc123', stderr: '' },
    'branch --show-current': { ok: true, stdout: 'main', stderr: '' },
    '-c core.quotepath=false status --short': { ok: true, stdout: '', stderr: '' },
    '-c core.quotepath=false diff HEAD --stat': { ok: true, stdout: '', stderr: '' }
  }
  const table = { ...defaults, ...overrides }
  return (async (args: string[]) => {
    const key = args.join(' ')
    const r = table[key]
    if (!r) throw new Error(`fakeGit: unexpected invocation "${key}"`)
    return r
  }) as typeof git
}

describe('readGitSummary', () => {
  it('clean 저장소: head/branch가 채워지고 changed는 빈 배열', async () => {
    dir = await makeRepo()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim()

    const summary = await readGitSummary(dir)

    expect(summary).not.toBeNull()
    expect(summary?.head).toBe(head)
    expect(summary?.branch).toBe('main')
    expect(summary?.changed).toEqual([])
  })

  it('수정된 파일이 있으면 changed에 그 경로가 담긴다', async () => {
    dir = await makeRepo()
    await fs.writeFile(path.join(dir, 'f.txt'), 'y\n', 'utf8')

    const summary = await readGitSummary(dir)

    expect(summary?.changed).toEqual(['f.txt'])
  })

  it('추가만 되고 커밋되지 않은 파일도 changed에 담긴다', async () => {
    dir = await makeRepo()
    await fs.writeFile(path.join(dir, 'new.txt'), 'new\n', 'utf8')

    const summary = await readGitSummary(dir)

    expect(summary?.changed).toEqual(['new.txt'])
  })

  it('rename된 파일은 changed에 새 경로만 담긴다("old -> new" 원문이 아니라) — fix round 1', async () => {
    dir = await makeRepo()
    run(dir, ['mv', 'f.txt', 'renamed.txt'])

    const summary = await readGitSummary(dir)

    expect(summary?.changed).toEqual(['renamed.txt'])
  })

  it('rename된 새 경로에 공백이 있으면 git이 감싼 큰따옴표를 벗기고 담는다 — fix round 1', async () => {
    dir = await makeRepo()
    run(dir, ['mv', 'f.txt', 'renamed with space.txt'])

    const summary = await readGitSummary(dir)

    expect(summary?.changed).toEqual(['renamed with space.txt'])
  })

  it('저장소가 아닌 디렉터리는 null', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-gitsummary-notrepo-'))

    expect(await readGitSummary(dir)).toBeNull()
  })

  it('존재하지 않는 경로는 null', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-gitsummary-missing-'))
    const missing = path.join(dir, 'does-not-exist')

    expect(await readGitSummary(missing)).toBeNull()
  })

  it('diffstat은 요약만 담고 diff 본문(추가/삭제된 실제 텍스트)은 담지 않는다', async () => {
    dir = await makeRepo()
    const bigLine = 'UNIQUE_BODY_LINE_' + 'x'.repeat(200)
    await fs.writeFile(path.join(dir, 'f.txt'), `${bigLine}\n`.repeat(50), 'utf8')

    const summary = await readGitSummary(dir)

    expect(summary?.diffstat).not.toBeNull()
    expect(summary?.diffstat ?? '').not.toContain(bigLine)
    // diffstat 요약 형태만 있어야 한다 — 예: " f.txt | 50 ++++---"
    expect(summary?.diffstat).toContain('f.txt')
  })

  // fix round 2: git 은 기본값(core.quotepath=true)에서 ASCII 밖 바이트를 8진 이스케이프로
  // 내보낸다 — `"\355\225\234..."` 는 **존재하지 않는 경로**이고, 브리핑을 읽는 에이전트가 그것을
  // 열려 하면 실패한다. 이 저장소의 작성자는 한국어로 일하므로 드문 경우가 아니라 기본 경우다.
  it('ASCII 밖 파일 이름을 8진 이스케이프가 아니라 그대로 담는다 — status 와 diffstat 양쪽', async () => {
    dir = await makeRepo()
    const name = '한글파일.txt'
    await fs.writeFile(path.join(dir, name), 'x\n', 'utf8')
    run(dir, ['add', name])

    const summary = await readGitSummary(dir)

    expect(summary?.changed).toEqual([name])
    expect(summary?.diffstat).toContain(name)
    expect(summary?.diffstat ?? '').not.toContain('\\355')
  })

  // fix round 2: `git diff` 는 인덱스를 무시한다. 워커가 `git add -A` 와 `git commit` 사이 —
  // 자기 커밋 의무의 두 단계 사이 — 에서 한도에 걸리면 changed 에는 파일이 있는데 diffstat 은
  // 비어, 브리핑이 스스로 모순된다.
  it('스테이지만 되고 커밋되지 않은 변경도 diffstat 에 담긴다', async () => {
    dir = await makeRepo()
    await fs.writeFile(path.join(dir, 'staged.txt'), 'staged\n', 'utf8')
    run(dir, ['add', 'staged.txt'])

    const summary = await readGitSummary(dir)

    expect(summary?.changed).toEqual(['staged.txt'])
    expect(summary?.diffstat).toContain('staged.txt')
  })

  it('변경이 없는 clean 저장소의 diffstat은 null', async () => {
    dir = await makeRepo()

    const summary = await readGitSummary(dir)

    expect(summary?.diffstat).toBeNull()
  })
})

// fix round 1 — Finding 1: rev-parse HEAD가 성공한 뒤로는 나머지 세 호출이 필드 단위로만 실패를
// 흡수해야 한다(하나가 exit 실패해도 나머지 필드는 정상값을 유지). 실제 git으로는 재현할 수 없는
// 상태라 git을 주입해 고정한다 — 이 describe 는 실제 저장소를 만들지 않는다.
describe('필드 단위 실패 흡수 (rev-parse HEAD 성공 뒤)', () => {
  it('branch 조회가 exit 실패(부분 stdout 포함)여도 branch만 null, 나머지는 정상', async () => {
    const summary = await readGitSummary('/fake/cwd', {
      git: fakeGit({ 'branch --show-current': { ok: false, stdout: 'partial', stderr: 'boom' } })
    })

    expect(summary?.branch).toBeNull()
    expect(summary?.head).toBe('abc123')
    expect(summary?.changed).toEqual([])
    expect(summary?.diffstat).toBeNull()
  })

  it('status 조회가 exit 실패(부분 stdout 포함)여도 changed는 빈 배열, 나머지는 정상', async () => {
    const summary = await readGitSummary('/fake/cwd', {
      git: fakeGit({ '-c core.quotepath=false status --short': { ok: false, stdout: 'partial', stderr: 'boom' } })
    })

    expect(summary?.changed).toEqual([])
    expect(summary?.head).toBe('abc123')
    expect(summary?.branch).toBe('main')
    expect(summary?.diffstat).toBeNull()
  })

  it('diffstat 조회가 exit 실패(부분 stdout 포함)여도 diffstat만 null, 나머지는 정상', async () => {
    const summary = await readGitSummary('/fake/cwd', {
      git: fakeGit({ '-c core.quotepath=false diff HEAD --stat': { ok: false, stdout: 'partial', stderr: 'boom' } })
    })

    expect(summary?.diffstat).toBeNull()
    expect(summary?.head).toBe('abc123')
    expect(summary?.branch).toBe('main')
    expect(summary?.changed).toEqual([])
  })
})
