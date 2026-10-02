// git 에게 지금 어디 있는지 묻는다 — 판정은 하지 않는다. 판정은 core/git/transition.ts 의 일이다.
import { git } from '../worktrees/git'
import { parsePorcelainZ } from '../git/status'
import type { GitRef } from '../git/types'
import type { CollectorGit } from './collector'
import { readRange, WATCH_ROUND_TIMEOUT_MS, type GitRun } from '../git/range'

/** 감시 고리(gitWatcher)에서 불린다 — 여기서 던지면 고리 전체가 멈춘다. 그래서 절대 던지지 않고,
 *  실패한 항목은 null 로 돌려준다.
 *
 *  **보통은 git 한 번이다:** `git rev-parse HEAD --abbrev-ref HEAD`. rev-parse 의 옵션은 그 뒤의
 *  인자에만 걸리므로 첫 줄은 HEAD 의 해시, 둘째 줄은 브랜치의 짧은 이름이다(detached 면 "HEAD").
 *  짧은 이름은 `symbolic-ref --short` 와 같은 함수(shorten_unambiguous_ref)가 만든다 — 브랜치와
 *  같은 이름의 태그가 있으면 둘 다 "heads/main" 을 준다(실측, git 2.45.1). 저장된 스냅샷의 브랜치
 *  이름이 이 변경 전후로 달라지지 않는다.
 *
 *  **그 한 번이 실패하면 예전의 두 번으로 되묻는다** — `symbolic-ref --short HEAD` 와 `rev-parse HEAD`.
 *  실측(git 2.45.1, Windows): 커밋이 하나도 없는 저장소에서 `rev-parse --abbrev-ref HEAD` 는
 *  "ambiguous argument 'HEAD'" 로 실패한다(exit 128) — 겉으로 있어야 할 unborn 브랜치 이름을
 *  주지 않는다. `symbolic-ref --short HEAD` 는 그 경우에도 "main" 을 답하고, HEAD 가 심볼릭
 *  ref 가 아닌 detached 상태에서는 그대로 실패해 null 이 된다. 되묻는 길은 이 변경 전의 코드
 *  그대로라, 드문 경우(unborn, 저장소가 아님)의 답도 전과 같다. git 이 아예 답하지 않았으면
 *  (종료 코드 없음) 되묻지 않고 둘 다 null 이다. */
export async function readGitRef(repoPath: string, run: GitRun = git): Promise<GitRef> {
  const opts = { cwd: repoPath, timeoutMs: WATCH_ROUND_TIMEOUT_MS }
  const both = await run(['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'], opts)
  if (both.ok) {
    const [head, name] = both.stdout.split(/\r?\n/)
    if (head && name) return { branch: name === 'HEAD' ? null : name, head }
  } else if (both.exitCode === undefined) {
    // git 이 답하지 않았다(시간 초과, 띄우지 못함). 되물어도 같은 자리에서 또 5초씩 선다 — 예전에도
    // 둘 다 답하지 못한 이 경우의 답은 { null, null } 이었다
    return { branch: null, head: null }
  }
  const branchResult = await run(['symbolic-ref', '--short', 'HEAD'], opts)
  const headResult = await run(['rev-parse', 'HEAD'], opts)
  const branch = branchResult.ok ? branchResult.stdout : null
  const head = headResult.ok ? headResult.stdout : null
  return { branch, head }
}

/**
 * before 가 after 의 조상인가. 둘 중 하나라도 없으면(물을 것이 없으면) null.
 *
 * **git 한 번이다:** `git merge-base --is-ancestor`. 그 종료 코드가 답의 셋을 그대로 가른다 —
 * 0 은 조상이다, 1 은 조상이 아니다, 그 밖(128: 커밋이 없다, 커밋이 아닌 오브젝트다)은 물을 수 없었다.
 * 종료 코드가 아예 없으면(시간 초과, 띄우지 못함) git 이 답하지 않은 것이다. **1 만 false 이고
 * 나머지 실패는 전부 null(모름)이다** — 커밋이 사라진 저장소를 "조상이 아니다"로 읽으면
 * history-rewritten 이 지어내진다(EG §22 가 금지한 억지 추정).
 *
 * 예전에는 어댑터가 두 실패를 ok:false 하나로 뭉개서, 묻기 전에 `cat-file -e` 로 두 커밋을 따로
 * 확인했다(git 세 번). 어댑터가 이제 `exitCode` 를 주므로(git 이 스스로 낸 종료 코드일 때만 있다)
 * 그 확인이 merge-base 자신의 종료 코드 안에 들어 있다. 실측(git 2.45.1): 없는 커밋은 before 쪽이든
 * after 쪽이든 128, 트리 오브젝트도 128, 조상이 아니면 1.
 */
export async function isAncestorOf(
  repoPath: string,
  before: string | null,
  after: string | null,
  run: GitRun = git
): Promise<boolean | null> {
  if (before === null || after === null) return null

  const opts = { cwd: repoPath, timeoutMs: WATCH_ROUND_TIMEOUT_MS }
  const r = await run(['merge-base', '--is-ancestor', before, after], opts)
  if (r.ok) return true
  return r.exitCode === 1 ? false : null
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
 *
 * **git 이 실패하면 null(모름)이다 — 빈 목록이 아니다.** 5초 안에 답하지 못했거나, 출력 한도에
 * 걸렸거나, 저장소인데 status 가 실패한 것을 []로 주면 깨끗한 작업 트리와 구별되지 않고, 수집기는
 * 그것을 "바뀐 것 없음"으로 읽어 쓰기 증거가 있는 Unit 을 지운다. 여전히 던지지는 않는다(감시 고리
 * 안에서 불린다).
 *
 * **저장소가 아닌 폴더는 [] 다 — 모름이 아니다.** git 이 없는 프로젝트에서는 git 으로 잴 변경도 없다.
 * 탐색기(ipc.ts 의 git.status)가 같은 구분을 한다. 이것을 null 로 주면 수집기가 그런 프로젝트의 모든
 * 완료를 "모름"으로 붙잡아, 파일 없는 기록을 남기고 설명 에이전트를 띄운다(명세 §12 가 막은 일).
 * 판정은 status 가 실패한 뒤에만 한 번 더 묻는다: `rev-parse --git-dir` 을 git 이 **스스로 거절했으면**
 * (종료 코드가 있으면) 저장소가 아니다. 시간 초과나 실행 실패는 답이 아니므로 그대로 null 이다.
 * 거절 문구는 보지 않는다 — git 은 로캘에 따라 번역된 문구를 낸다.
 */
export async function readChangedFiles(repoPath: string, run: GitRun = git): Promise<string[] | null> {
  const opts = { cwd: repoPath, timeoutMs: WATCH_ROUND_TIMEOUT_MS, trim: false }
  const r = await run(['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all'], opts)
  if (r.ok) return parsePorcelainZ(r.stdout).map((e) => e.relPath)
  const probe = await run(['rev-parse', '--git-dir'], opts)
  if (!probe.ok && probe.exitCode !== undefined) return [] // git 이 답했다: 저장소가 아니다 — 확실히 바뀐 것 없음
  return null // 저장소인데 status 가 실패했거나, git 이 답하지 못했다 — 모른다
}

/** 수집기(`CollectorGit`)가 쓰는 git 네 가지를 한 runner 위에 묶는다. ipc.ts 는 함수 넷을 그대로
 *  넘기고(기본 runner), 테스트는 세는 runner 를 넣어 이것을 쓴다. */
export function probeGit(run: GitRun = git): CollectorGit {
  return {
    readRef: (repoPath) => readGitRef(repoPath, run),
    isAncestor: (repoPath, before, after) => isAncestorOf(repoPath, before, after, run),
    changedFiles: (repoPath) => readChangedFiles(repoPath, run),
    readRange: (repoPath, before, after) => readRange(repoPath, before, after, run)
  }
}
