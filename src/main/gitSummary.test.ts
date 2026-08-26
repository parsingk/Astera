import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readGitSummary } from './gitSummary'

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

  it('변경이 없는 clean 저장소의 diffstat은 null', async () => {
    dir = await makeRepo()

    const summary = await readGitSummary(dir)

    expect(summary?.diffstat).toBeNull()
  })
})
