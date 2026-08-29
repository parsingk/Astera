// git 에게 지금 어디 있는지 묻는다 — 판정은 하지 않는다. 판정은 core/git/transition.ts 의 일이다.
import { git } from '../../core/worktrees/git'
import type { GitRef } from '../../core/git/types'

/** 감시 고리(gitWatcher)에서 불린다 — 여기서 던지면 고리 전체가 멈춘다. 그래서 절대 던지지 않고,
 *  실패한 항목은 null 로 돌려준다.
 *
 *  브랜치는 `git symbolic-ref --short HEAD` 로 묻는다 — `rev-parse --abbrev-ref HEAD` 가 아니다.
 *  실측(git 2.45.1, Windows): 커밋이 하나도 없는 저장소에서 `rev-parse --abbrev-ref HEAD` 는
 *  "ambiguous argument 'HEAD'" 로 실패한다(exit 128) — 겉으로 있어야 할 unborn 브랜치 이름을
 *  주지 않는다. `symbolic-ref --short HEAD` 는 그 경우에도 "main" 을 답하고, HEAD 가 심볼릭
 *  ref 가 아닌 detached 상태에서는 그대로 실패해 null 이 된다 — 이 함수가 원하는 모양 그대로다. */
export async function readGitRef(repoPath: string): Promise<GitRef> {
  const branchResult = await git(['symbolic-ref', '--short', 'HEAD'], { cwd: repoPath })
  const headResult = await git(['rev-parse', 'HEAD'], { cwd: repoPath })
  const branch = branchResult.ok ? branchResult.stdout : null
  const head = headResult.ok ? headResult.stdout : null
  return { branch, head }
}

/**
 * before 가 after 의 조상인가. 둘 중 하나라도 없으면(물을 것이 없으면) null.
 *
 * `git merge-base --is-ancestor` 는 조상이 아니면 종료 코드 1, 커밋이 없는 등 명령 자체가 실패하면
 * 그 밖의 코드를 주지만, `git()` 어댑터는 둘 다 ok:false 로 뭉갠다. 그대로 쓰면 커밋이 사라진
 * 저장소에서 "조상이 아니다"로 읽혀 history-rewritten 이 지어내진다(EG §22 가 금지한 억지 추정).
 * 그래서 묻기 전에 두 커밋이 실제로 있는지 확인하고, 하나라도 없으면 null 을 준다.
 */
export async function isAncestorOf(
  repoPath: string,
  before: string | null,
  after: string | null
): Promise<boolean | null> {
  if (before === null || after === null) return null

  const beforeExists = await git(['cat-file', '-e', `${before}^{commit}`], { cwd: repoPath })
  const afterExists = await git(['cat-file', '-e', `${after}^{commit}`], { cwd: repoPath })
  if (!beforeExists.ok || !afterExists.ok) return null

  return (await git(['merge-base', '--is-ancestor', before, after], { cwd: repoPath })).ok
}
