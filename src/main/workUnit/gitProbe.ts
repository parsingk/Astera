// git 에게 지금 어디 있는지 묻는다 — 판정은 하지 않는다. 판정은 core/git/transition.ts 의 일이다.
import { git } from '../../core/worktrees/git'
import { parsePorcelainZ } from '../../core/git/status'
import type { GitRef } from '../../core/git/types'

/** `git status` 는 감시 고리(gitWatcher) 안에서 돌므로 매달리면 안 된다. ipc.ts 의 git.status 와 같은 값 */
const STATUS_TIMEOUT_MS = 5_000

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

/**
 * 작업 트리에서 지금 바뀌어 있는 파일들. `CollectorGit.changedFiles` 의 실제 구현이다.
 *
 * `--no-optional-locks` 가 반드시 필요하다: 없으면 status 가 `.git/index` 를 갱신하고 그것이 다시
 * GitWatcher 를 깨워 무한 고리가 된다 (ipc.ts 의 git.status 핸들러가 같은 이유로 같은 플래그를 쓴다).
 * `trim:false` 도 같다 — porcelain 레코드는 `XY<공백>경로` 라 앞 공백을 깎으면 경로의 첫 글자가 함께 날아간다.
 *
 * (Task 11 은 이 함수를 collector.ts 에 두었다 — 그때는 이 파일을 고칠 수 없다는 제약이 있었다. 이
 * 태스크는 그 제약이 없어 제자리로 옮긴다: git 에 말을 거는 일이 두 파일에 나뉘어 있을 이유가 없다.)
 */
export async function readChangedFiles(repoPath: string): Promise<string[]> {
  const r = await git(
    ['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all'],
    { cwd: repoPath, timeoutMs: STATUS_TIMEOUT_MS, trim: false }
  )
  if (!r.ok) return [] // 저장소가 아니거나 git 이 실패했다 — 관찰된 변경이 없는 것으로 본다
  return parsePorcelainZ(r.stdout).map((e) => e.relPath)
}

// 파일 이름이 우연히 40자 hex 와 같은 모양이 될 가능성은 사실상 없다 — 커밋 해시 줄과 파일 줄을
// 가르는 데 쓴다 (readRange 의 주석).
const COMMIT_HASH_RE = /^[0-9a-f]{40}$/

/**
 * before..after 구간의 커밋 해시들과 그 구간에서 바뀐 파일들. 수집기는 `fast-forward` 로 확인된
 * 전이에서만 이것을 부른다 — 그 밖의 전이는 `before..after` 범위 자체를 신뢰할 수 없다
 * (`core/git/types.ts` 의 `ExternalGitChange.commits` 주석).
 *
 * 한 번의 `git log --name-only` 로 커밋과 파일을 함께 받는다. `--pretty=format:%H` 가 커밋마다
 * 40자 hex 해시 한 줄을 내고 그 뒤로 `--name-only` 가 그 커밋에서 바뀐 파일들을 한 줄씩 낸다 —
 * 실측(git 2.45.1): `<hash>\n<file>\n<file>\n\n<hash>\n<file>\n` (커밋 사이는 빈 줄로 갈린다,
 * 머지 커밋처럼 파일이 없는 커밋은 다음 해시 줄로 바로 이어진다). 그래서 각 줄을 40자 hex 정규식으로
 * 먼저 걸러 해시 줄과 파일 줄을 가른다.
 *
 * 실패하면(저장소가 아니다, 커밋을 못 찾는다) 빈 목록이다 — **절대 던지지 않는다.** 감시 고리
 * (gitWatcher) 안에서 불린다.
 */
export async function readRange(
  repoPath: string,
  before: string,
  after: string
): Promise<{ commits: string[]; changedFiles: string[] }> {
  const r = await git(['log', '--pretty=format:%H', '--name-only', `${before}..${after}`], {
    cwd: repoPath
  })
  if (!r.ok) return { commits: [], changedFiles: [] }

  const commits: string[] = []
  const files = new Set<string>()
  for (const line of r.stdout.split('\n')) {
    if (line === '') continue
    if (COMMIT_HASH_RE.test(line)) commits.push(line)
    else files.add(line)
  }
  return { commits, changedFiles: [...files] }
}
