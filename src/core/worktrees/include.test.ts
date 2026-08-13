import { describe, it, expect } from 'vitest'
import type { TestContext } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseWorktreeInclude, copyWorktreeInclude, dirSize } from './include'
import { makeRepo, tempDir } from './testRepo'

/** symlink 생성 실패가 권한 문제(EPERM/EACCES)면 실패가 아니라 스킵으로 처리한다(리뷰 Finding 5) —
 *  Windows는 보통 관리자 권한/Developer Mode가 있어야 symlink를 만들 수 있고, 그게 없는 CI나
 *  다른 개발자 머신에서는 "진짜 결함"이 아니라 "환경 제약"이라 실패로 취급하면 안 된다. */
async function trySymlink(
  ctx: TestContext,
  target: string,
  linkPath: string,
  type: 'file' | 'dir'
): Promise<void> {
  try {
    await fs.symlink(target, linkPath, type)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') {
      ctx.skip(`symlink 생성 권한 없음(${code}) — 이 환경은 관리자 권한/Developer Mode가 없습니다`)
    }
    throw err
  }
}

describe('parseWorktreeInclude', () => {
  it('주석·빈 줄 무시, 리터럴만 통과', () => {
    const r = parseWorktreeInclude('# c\n\n.env\nconfig/local.json\n')
    expect(r.entries).toEqual(['.env', 'config/local.json'])
    expect(r.warnings).toEqual([])
  })
  it('glob·부정·절대경로·..·.git은 경고 후 스킵', () => {
    const r = parseWorktreeInclude('*.env\n!x\n/abs\nC:\\abs\n../up\n.git/config\nok.txt\n')
    expect(r.entries).toEqual(['ok.txt'])
    // 5개 카테고리(glob·부정·절대경로·..·.git)지만 절대경로 예시가 2줄(/abs, C:\abs)이라 경고는 6개
    expect(r.warnings.length).toBe(6)
    expect(r.warnings[0]).toEqual({ key: 'worktree.include.globUnsupported', params: { line: '*.env' } })
    expect(r.warnings[2]).toEqual({ key: 'worktree.include.absolutePath', params: { line: '/abs' } })
  })
  it('1000줄 초과분은 경고 후 무시', () => {
    const content = Array.from({ length: 1001 }, (_, i) => `f${i}.txt`).join('\n')
    const r = parseWorktreeInclude(content)
    expect(r.entries.length).toBe(1000)
    expect(r.warnings).toEqual([{ key: 'worktree.include.tooManyEntries', params: { max: 1000 } }])
  })
  it('선행 . 세그먼트로 .git 가드를 우회할 수 없다 (리뷰 Finding 2)', () => {
    // segs[0]만 보면 './.git/config'는 세그먼트가 ['.', '.git', 'config']라 통과해버린다
    const r = parseWorktreeInclude('./.git/config\n')
    expect(r.entries).toEqual([])
    expect(r.warnings).toEqual([{ key: 'worktree.include.gitDir', params: { line: './.git/config' } }])
  })
})

describe('copyWorktreeInclude', () => {
  it('존재+gitignored 항목만 복사, tracked·미존재는 경고 스킵', async () => {
    const repo = await makeRepo('astera-wt-inc-')
    await fs.writeFile(path.join(repo, '.gitignore'), '.env\nsecrets/\n', 'utf8')
    await fs.writeFile(path.join(repo, '.env'), 'KEY=1', 'utf8')
    await fs.mkdir(path.join(repo, 'secrets'))
    await fs.writeFile(path.join(repo, 'secrets', 's.txt'), 's', 'utf8')
    // f.txt는 tracked(makeRepo가 커밋) — 복사 대상 아님
    await fs.writeFile(
      path.join(repo, '.worktreeinclude'),
      '.env\nsecrets\nf.txt\nno-such.txt\n',
      'utf8'
    )
    execFileSync('git', ['add', '.gitignore', '.worktreeinclude'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['commit', '-m', 'inc'], { cwd: repo, windowsHide: true })
    const wt = await tempDir('astera-wt-dest-')
    const warnings = await copyWorktreeInclude(repo, wt)
    expect(await fs.readFile(path.join(wt, '.env'), 'utf8')).toBe('KEY=1')
    expect(await fs.readFile(path.join(wt, 'secrets', 's.txt'), 'utf8')).toBe('s')
    await expect(fs.stat(path.join(wt, 'f.txt'))).rejects.toThrow() // tracked → 미복사
    // f.txt(ignored 아님) + no-such.txt(미존재)
    expect(warnings).toEqual([
      { key: 'worktree.include.notIgnored', params: { entry: 'f.txt' } },
      { key: 'worktree.include.missing', params: { entry: 'no-such.txt' } }
    ])
  })

  it('.worktreeinclude 자체가 없으면 무동작·경고 없음', async () => {
    const repo = await makeRepo('astera-wt-inc2-')
    const wt = await tempDir('astera-wt-dest2-')
    expect(await copyWorktreeInclude(repo, wt)).toEqual([])
  })

  it('한 항목의 복사 실패는 throw하지 않고, 이후 항목은 계속 복사된다 (리뷰 Finding 1)', async () => {
    const repo = await makeRepo('astera-wt-inc3-')
    await fs.writeFile(path.join(repo, '.gitignore'), 'a/\nok2.txt\n', 'utf8')
    await fs.mkdir(path.join(repo, 'a', 'b'), { recursive: true })
    await fs.writeFile(path.join(repo, 'a', 'b', 'c.txt'), 'x', 'utf8')
    await fs.writeFile(path.join(repo, 'ok2.txt'), 'y', 'utf8')
    await fs.writeFile(
      path.join(repo, '.worktreeinclude'),
      'a/b/c.txt\nok2.txt\n', // a/b/c.txt가 먼저 — mkdir 충돌로 실패해도 ok2.txt는 계속 진행돼야 함
      'utf8'
    )
    execFileSync('git', ['add', '.gitignore', '.worktreeinclude'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['commit', '-m', 'inc3'], { cwd: repo, windowsHide: true })
    const wt = await tempDir('astera-wt-dest3-')
    // 목적지에 'a'를 파일로 미리 만들어 fs.mkdir(recursive)가 ENOTDIR로 충돌하게 강제
    await fs.writeFile(path.join(wt, 'a'), 'blocker', 'utf8')
    const warnings = await copyWorktreeInclude(repo, wt) // throw 없이 resolve되어야 함
    expect(warnings.some((w) => w.key === 'worktree.include.copyFailed')).toBe(true)
    expect(await fs.readFile(path.join(wt, 'ok2.txt'), 'utf8')).toBe('y') // 이후 항목은 정상 복사
  })
})

describe('dirSize', () => {
  it('심볼릭 링크는 dereference된 실체 크기로 집계한다 (리뷰 Finding 3)', async (ctx) => {
    // fs.cp(..., { dereference: true })는 링크의 실체를 복사하므로, 용량 상한 계산도
    // dirent 기준(isFile/isDirectory 둘 다 false)이 아니라 실체 stat 기준이어야 한다.
    const dir = await tempDir('astera-wt-dirsize-')
    await fs.writeFile(path.join(dir, 'real.txt'), 'x'.repeat(1000), 'utf8')
    await trySymlink(ctx, path.join(dir, 'real.txt'), path.join(dir, 'link.txt'), 'file')
    expect(await dirSize(dir)).toBe(2000) // real.txt(1000) + link.txt 실체(1000), 0으로 누락되면 안 됨
  })

  it(
    '디렉토리 symlink 순환은 무한 재귀 없이 settle하고 실파일 크기만 센다 (리뷰 Finding 4)',
    async (ctx) => {
      // dir/sub/back -> dir : pnpm류 node_modules에 흔한 디렉토리 symlink 순환을 그대로 재현
      const dir = await tempDir('astera-wt-dirsize-cycle-')
      await fs.writeFile(path.join(dir, 'real.txt'), 'x'.repeat(500), 'utf8')
      await fs.mkdir(path.join(dir, 'sub'))
      await trySymlink(ctx, dir, path.join(dir, 'sub', 'back'), 'dir')
      const size = await dirSize(dir) // 이 await가 settle하지 않으면(=순환에 빠지면) 아래 타임아웃으로 실패
      expect(size).toBe(500) // back 순환분은 0으로 스킵, real.txt만 집계
    },
    2000 // vitest 기본 타임아웃보다 훨씬 짧게 — 회귀 시 hang이 아니라 타임아웃으로 빠르게 실패
  )
})
