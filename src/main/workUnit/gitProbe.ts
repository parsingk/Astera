// git 에게 지금 어디 있는지 묻는다 — 판정은 하지 않는다. 판정은 core/git/transition.ts 의 일이다.
import { git } from '../../core/worktrees/git'
import { parsePorcelainZ } from '../../core/git/status'
import type { GitRef } from '../../core/git/types'

/** 감시 고리(gitWatcher) 안에서 도는 호출은 매달리면 안 된다 — `readChangedFiles` 도 `readRange` 도
 *  같은 회차(gitRound) 안에서 불린다. ipc.ts 의 git.status 와 같은 값. */
const WATCH_ROUND_TIMEOUT_MS = 5_000

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
 * (이 함수는 한동안 collector.ts 에 있었다 — 그때는 이 파일을 고칠 수 없다는 제약이 있어서였다.
 * 지금은 그 제약이 없어 제자리로 옮긴다: git 에 말을 거는 일이 두 파일에 나뉘어 있을 이유가 없다.)
 */
export async function readChangedFiles(repoPath: string): Promise<string[]> {
  const r = await git(
    ['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all'],
    { cwd: repoPath, timeoutMs: WATCH_ROUND_TIMEOUT_MS, trim: false }
  )
  if (!r.ok) return [] // 저장소가 아니거나 git 이 실패했다 — 관찰된 변경이 없는 것으로 본다
  return parsePorcelainZ(r.stdout).map((e) => e.relPath)
}

/**
 * before..after 구간의 커밋 해시들과 그 구간에서 바뀐 파일들. 수집기는 **두 HEAD 가 다른 전이라면
 * 무엇이든** 이것을 부르고, 돌려받은 둘을 다르게 쓴다 — `commits` 는 `fast-forward` 에서만 쓴다
 * (그 밖의 전이에서는 `before..after` 를 커밋 목록으로 신뢰할 수 없다, `core/git/types.ts` 의
 * `ExternalGitChange.commits` 주석). `changedFiles` 는 어느 전이에서나 쓴다 — 아래에 적었듯 그 값을
 * 내는 것은 `git diff before..after` 이고 그것은 **두 트리의 비교**라 브랜치를 갈아타든 역사를 다시
 * 쓰든 옳다(collector.ts 의 gitRound 주석).
 *
 * **따로 묻는다 — 한 스트림에 섞지 않는다.** 처음엔 `git log --name-only` 하나로 커밋과 파일을
 * 같이 받고 해시 줄을 40자 hex 모양으로 골라냈지만, 그 모양 판정은 두 가지로 깨진다: SHA-256
 * 저장소의 64자 해시가 전부 "파일"로 잘못 잡혀 커밋 목록이 비고, 40자 hex 그대로인 파일 이름이
 * "커밋"으로 잘못 잡힌다. 거기다 `--name-only` 는 파일이 있는 커밋에서만 헤더 뒤에 개행을 넣고
 * 파일이 없는 커밋(빈 커밋)에서는 넣지 않아, 한 스트림 안에서 경계를 셀 때 그 개행의 유무까지
 * 가려야 한다 — 실측(git 2.45.1)으로 확인했다. 그래서 커밋과 파일을 **구조적으로 분리된 두 번의
 * 호출**로 받는다: 하나는 해시만, 하나는 파일만 낸다. 어느 쪽도 "이게 해시처럼 생겼나"를 묻지
 * 않으므로 다이제스트 길이나 파일 이름 모양과 무관하게 옳다.
 *
 * 둘 다 `-z` 로 NUL 구분한다(개행이 아니다 — 커밋 메시지에 개행이 있을 수 있고, 여기서는 안
 * 쓰지만 옆의 `readChangedFiles` 가 이미 같은 이유로 -z 를 쓴다). 파일 목록 쪽에는
 * `-c core.quotePath=false` 도 준다 — 없으면 비 ASCII 경로가 8진 이스케이프로 인용된다
 * (실측: 파일 `한글.txt` 가 `"\355\225\234\352\270\200.txt"` 로 나온다). 그러면 그 문자열이
 * 그대로 저장돼 사람이 읽을 수 없는 경로가 남는다 — 한글이 흔한 이 코드베이스에서는 드문 일이
 * 아니다.
 *
 * 실패하면(저장소가 아니다, 커밋을 못 찾는다) 셋 다 빈 목록이다 — **절대 던지지 않는다.** 감시
 * 고리(gitWatcher) 안에서 불린다.
 *
 * **author 도 따로 묻는다 — 형식 문자열에 붙이지 않는다.** `--pretty=format:%H%x00%an` 하나로
 * 받으면 스트림이 `해시\0이름\0해시\0이름` 이 되어 **자리로 짝을 맞춰야** 하고, 그러면 이름이 빈
 * 커밋 하나에 그 뒤의 짝이 통째로 어긋난다 — 지금 옳게 도는 `commits` 를 그 위험에 얹는 것이다.
 * 이 파일이 바로 위 문단에서 커밋과 파일을 갈라 물은 이유가 그것과 같다. `Promise.all` 안이라
 * 호출이 하나 늘어도 걸리는 시간은 그대로이고, 이 호출은 두 HEAD 가 다른 외부 전이에서만 돈다.
 *
 * **중복을 지운다.** EG §7 이 보여 주는 것은 "당겨온 커밋들에 있던 이름들" 목록이지 커밋마다의
 * 짝이 아니고, 짝을 약속하지 않으면 위의 정렬 문제도 애초에 생기지 않는다.
 */
export async function readRange(
  repoPath: string,
  before: string,
  after: string
): Promise<{ commits: string[]; changedFiles: string[]; authors: string[] }> {
  const range = `${before}..${after}`
  const opts = { cwd: repoPath, timeoutMs: WATCH_ROUND_TIMEOUT_MS, trim: false }
  // 파일 쪽은 `git diff before..after --name-only` 다 — 커밋마다의 `--name-only` 목록을 합집합으로
  // 모으던 이전 방식과 다르고, **일부러 바꿨다.** `git log --name-only` 는 머지 커밋 자신을 위한
  // diff 를 내지 않는다(그 커밋이 부모들과 갈라지는 지점만 보여주고, 머지 자신이 새로 들여온
  // 변경은 조용히 빠진다). `diff before..after` 는 그 두 커밋의 트리를 통째로 견주므로, 그 사이에
  // 머지가 가져온 변경까지 전부 들어간다 — 그래서 이쪽이 낫다.
  const [log, diff, who] = await Promise.all([
    git(['log', '--pretty=format:%H', '-z', range], opts),
    git(['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', range], opts),
    git(['log', '--pretty=format:%an', '-z', range], opts)
  ])
  if (!log.ok || !diff.ok) return { commits: [], changedFiles: [], authors: [] }

  const split = (s: string): string[] => s.split('\0').filter((t) => t !== '')
  // author 만 실패했다면 나머지 둘은 그대로 준다 — 이름은 표시용이고(EG §7), 커밋과 파일이
  // 다음 계획의 기능 매핑을 먹이는 값이다. 하나를 못 얻었다고 둘을 함께 버릴 이유가 없다.
  return {
    commits: split(log.stdout),
    changedFiles: split(diff.stdout),
    authors: who.ok ? [...new Set(split(who.stdout))] : []
  }
}
