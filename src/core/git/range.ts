// git range reader (before..after) — the Host and the app both use it, so it lives in core.
import { git, type GitResult } from '../worktrees/git'

/** A call made inside the watch loop (gitWatcher) must not hang. readRange here and the round
 *  functions in main/workUnit/gitProbe.ts all run inside the same round (gitRound), so they all use
 *  this value. With the adapter's default (30 s), one stuck git would hold the collector's serial
 *  queue that long. The same value as ipc.ts's git.status. */
export const WATCH_ROUND_TIMEOUT_MS = 5_000

/** git 한 번을 띄우는 길. 기본은 어댑터(`core/worktrees/git`)이고, 테스트는 이것을 감싸 이 파일이 한
 *  회차에 git 을 몇 번 띄우는지 센다(collector.test.ts 의 spawn 수 테스트). 바이러스 백신이 프로세스
 *  하나마다 값을 매기는 Windows 에서 그 수가 곧 회차의 비용이다. */
export type GitRun = (
  args: string[],
  opts: { cwd: string; timeoutMs: number; trim?: boolean }
) => Promise<GitResult>

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
 * 실패하면(저장소가 아니다, 커밋을 못 찾는다, 시간 초과, 출력 한도) **null(모름)** 이다 — 빈 목록이
 * 아니다. 빈 목록은 "그 구간에 바뀐 것이 없다"는 답이고, 큰 pull 뒤에 한도를 넘어 실패한 것을 그렇게
 * 적으면 거짓 기록이 된다. **절대 던지지 않는다.** 감시 고리(gitWatcher) 안에서 불린다.
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
  after: string,
  run: GitRun = git
): Promise<{ commits: string[]; changedFiles: string[]; authors: string[]; subjects: string[] } | null> {
  const range = `${before}..${after}`
  const opts = { cwd: repoPath, timeoutMs: WATCH_ROUND_TIMEOUT_MS, trim: false }
  // 파일 쪽은 `git diff before..after --name-only` 다 — 커밋마다의 `--name-only` 목록을 합집합으로
  // 모으던 이전 방식과 다르고, **일부러 바꿨다.** `git log --name-only` 는 머지 커밋 자신을 위한
  // diff 를 내지 않는다(그 커밋이 부모들과 갈라지는 지점만 보여주고, 머지 자신이 새로 들여온
  // 변경은 조용히 빠진다). `diff before..after` 는 그 두 커밋의 트리를 통째로 견주므로, 그 사이에
  // 머지가 가져온 변경까지 전부 들어간다 — 그래서 이쪽이 낫다.
  const [log, diff, who, subj] = await Promise.all([
    run(['log', '--pretty=format:%H', '-z', range], opts),
    run(['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', range], opts),
    run(['log', '--pretty=format:%an', '-z', range], opts),
    // Subject lines (%s) for the write-up pipeline's material (core/understanding/pipeline.ts's
    // readCommits). `commits` above is hashes, useful for identity but meaningless as prompt text —
    // this is the human-readable counterpart, asked for over the same range for the same reason
    // authors is: a hash tells the agent nothing, so it needs its own query.
    run(['log', '--pretty=format:%s', '-z', range], opts)
  ])
  if (!log.ok || !diff.ok) return null

  const split = (s: string): string[] => s.split('\0').filter((t) => t !== '')
  // author 만 실패했다면 나머지 둘은 그대로 준다 — 이름은 표시용이고(EG §7), 커밋과 파일이
  // 다음 계획의 기능 매핑을 먹이는 값이다. 하나를 못 얻었다고 둘을 함께 버릴 이유가 없다.
  return {
    commits: split(log.stdout),
    changedFiles: split(diff.stdout),
    authors: who.ok ? [...new Set(split(who.stdout))] : [],
    subjects: subj.ok ? split(subj.stdout) : []
  }
}
