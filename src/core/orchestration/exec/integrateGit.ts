// The worktree git of orchestration: forking a worktree off the branch a project stands on, and
// merging finished worktrees back into a folder. Moved out of the app's bootOrch closures so that the
// Host can run the same git (S3): every check, every command and every rollback below is the one the
// app ran, in the same order. What differs between the two processes is injected: where the log goes,
// who is told Astera is about to move HEAD, and how a merged worktree is removed.
//
// This module must stay importable by the Host: no electron, nothing from src/main.

import { existsSync } from 'node:fs'
import path from 'node:path'
import type { OrchServerDeps } from '../command'
import { isSamePath } from '../../files/tree'
import { createWorktree } from '../../worktrees/create'
import { workerBaseFailure } from '../../worktrees/base'
import { git as realGit, gitDir, gitVersionAtLeast, listGitWorktrees } from '../../worktrees/git'
import { removeWorktree } from '../../worktrees/remove'
import type { WorktreeStore } from '../../worktrees/registry'

/** 프로젝트 폴더가 **서 있는 브랜치**에서 워크트리를 하나 만들고 그 경로를 낸다.
 *
 *  워커의 워크트리도 Run 의 워크트리도 프로젝트가 서 있는 브랜치에서 갈라져야 한다.
 *  createWorktree 의 자동 판정(origin/HEAD → main → master, core/worktrees/git.ts 의
 *  detectBaseRef)에 맡기면 프로젝트의 기본 브랜치에서 갈라지고 — Run 이 서 있는 브랜치와 다른
 *  조상이다 — 병합 단계가 무의미해진다: 의존의 워크트리를 이 뿌리로 접어 넣은 뒤 Task 를
 *  시작하는데, origin/HEAD 에서 갈라진 워커에게는 그 히스토리가 애초에 조상이 아니어서 병합
 *  때문에 보이는 것이 하나도 바뀌지 않는다.
 *
 *  문자열 'HEAD' 를 그대로 넘길 수 없다: baseRef 는 toFullRef 를 지나는데 슬래시 없는 이름을
 *  refs/heads/<name> 으로만 푼다 — 'HEAD' 는 refs/heads/HEAD 를 찾아 없으므로 NO_BASE 로
 *  던진다. 그래서 브랜치의 짧은 이름을 먼저 읽는다.
 *
 *  `rev-parse --abbrev-ref HEAD` 가 아니라 `symbolic-ref --quiet --short HEAD` 를 쓴다:
 *  전자는 분리된 HEAD 에서 실패하지 않고 리터럴 'HEAD' 를 돌려주므로, 그 값을 믿는 호출자는
 *  존재하지 않는 'HEAD' 라는 브랜치에서 갈라지려 한다. symbolic-ref 는 분리된 HEAD 에서
 *  그냥 실패하고, 그 실패가 정확히 여기 필요한 신호다. 이 저장소의 다른 두 곳도 같은 질문을
 *  같은 방식으로 묻는다(integrateWorktrees 의 병합 전 확인, git.ts 의 listBranches).
 *
 *  **저장소에 닿는지를 먼저 묻는다.** symbolic-ref 는 유효한 저장소에서만 "분리됐는가" 를
 *  답한다 — 그 경로에서 git 을 돌릴 수 없을 때도 똑같이 실패하므로, 그 실패를 곧 분리로 읽던
 *  동안 앱은 폴더가 사라진 Run 에도 "HEAD 가 분리됐다"고 말했다. 어느 쪽인지 가르는 것은
 *  core 의 workerBaseFailure 이고 문장도 그쪽에 있다.
 *
 *  **자동 판정으로 조용히 물러나지 않고 던진다.** 물러나면 이 확인이 막으려던 버그가 그대로
 *  되살아나고, 워커는 나중에 아무 데도 합칠 수 없는 일을 하게 된다 — 워커 세션 하나를 통째로
 *  태운 뒤에야 문제가 보인다. 여기서 던지면 시작 시점에 보고된다.
 *
 *  toFullRef 의 해석 순서에 남은 위험(브랜치 이름의 첫 조각이 원격 이름과 같을 때 원격 추적
 *  사본에서 갈라진다)은 그대로다 — 이 저장소의 원격은 origin 하나이고 어느 지역 브랜치의 첫
 *  조각도 그것과 다르다. 그 판단의 전문은 이 헬퍼를 뽑아 온 자리(git.ts 의 fetchBaseRef 주석)에
 *  있다. */
export async function forkWorktree(
  a: { repoPath: string; name?: string },
  ctx: { registry: WorktreeStore; log(m: string): void }
): Promise<string> {
  const gitDirProbe = await realGit(['rev-parse', '--git-dir'], { cwd: a.repoPath })
  const head = gitDirProbe.ok
    ? await realGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: a.repoPath })
    : { ok: false, stdout: '', stderr: '' }
  const baseFailure = workerBaseFailure({
    repoPath: a.repoPath,
    repoReachable: gitDirProbe.ok,
    onBranch: head.ok,
    stderr: gitDirProbe.stderr || gitDirProbe.stdout
  })
  if (baseFailure !== null) throw new Error(baseFailure)
  const r = await createWorktree({
    repoPath: a.repoPath,
    name: a.name,
    baseRef: head.stdout,
    registry: ctx.registry
  })
  // 경고를 버리지 않는다 — worktree.create.fetchFailed 는 "base 를 가져올 수 없어 낡은 참조에서
  // 만들었다" 는 뜻이고 워커는 그 위에서 일한다. 이 경로에는 사용자 화면이 없어 로그가 유일한
  // 흔적이다. 키만 남긴다: 번역은 렌더러의 일이고 여기에는 언어가 없다.
  for (const w of r.warnings) ctx.log(`worktree warning ${w.key} ${JSON.stringify(w.params ?? {})}`)
  return r.info.path
}

/** 통합의 결과. 셋뿐이다 — 합쳤다, 사람에게 가야 한다, 에이전트에게 넘겨야 한다. */
export type Integration =
  /** uncommitted: 합친 워크트리들에 **커밋되지 않은 채 남은** 변경의 수. git 은 커밋만 옮기므로
   *  그 변경은 병합되지 않았고 그 폴더에만 있다 — 폴더를 지우면 사라진다. 워커에게 커밋 의무를
   *  주기는 하지만(coordinator 의 commitObligation) 지켰는지 확인하는 곳은 없어서, 이 수가
   *  사람에게 그 사실이 닿는 유일한 자리다. */
  | { kind: 'merged'; uncommitted: number }
  | { kind: 'human'; reason: string }
  | { kind: 'agent'; reason: string; worktrees: { path: string; branch: string | null }[] }

export interface IntegrateContext {
  log(m: string): void
  /** Who is told Astera is moving HEAD (EG §26): the app's collector in the app, `git-op` in the Host (R7). */
  gitOp: { begin(kind: 'job-merge', cwd: string): string; end(id: string): void }
  /** Removes one merged worktree; never throws (reapWorktree). */
  reap(worktreePath: string): Promise<boolean>
  /** Test seams for rules 6 and 8 of the design's §3.2: an old git and the merge's argv cannot be
   *  produced by a real repository. Default to the real ones. */
  git?: typeof realGit
  gitAtLeast?: typeof gitVersionAtLeast
}

/** 워크트리에서 끝난 일을 **합칠 폴더에 실제로 합친다.** 그 폴더는 부르는 쪽이 정한다 —
 *  스케줄러는 Run 뿌리를 주고 `run-delete --merge` 는 프로젝트 폴더를 준다. 무엇을 합쳐야
 *  하는가의 판정은 integrate.ts 가 하고(순수하므로 테스트가 있다), 이 함수는 그 답을 git 으로
 *  실행한다.
 *
 *  **이것이 사용자의 저장소에 스스로 쓰는 유일한 자동 경로다.** 사용자가 그렇게 결정했으므로
 *  허용되지만, 지켜야 하는 것이 하나 있다: **어떤 실패 경로에서도 합칠 폴더를 병합 중간
 *  상태로 남기지 않는다.** 아래의 순서(미리 검사 → 진짜 병합 → 실패하면 되돌리고 되돌아갔는지
 *  확인)가 전부 그것을 위한 것이다. */
/**
 * 워크트리 브랜치들을 `mergeInto` 에 합친다.
 *
 * **`reap` 이 두 호출자를 가른다.** 기본값이 참인 것은 스케줄러의 통합 병합이다 — 그 워크트리는
 * 끝난 의존의 것이고 방금 접어 넣었으므로 다시 쓸 사람이 없다. 회차마다 워커 수만큼 폴더가
 * 쌓이는 것을 막는 것이 그 자동 정리의 이유다(스물일곱 개까지 갔다).
 *
 * `reap: false` 로 부르는 것은 사람이 누르는 병합(`run-merge`)과 `run-delete --merge` 다. 폴더를
 * 지우는 것은 그 사람의 몫이다 — 삭제 모달에는 그 체크박스가 따로 있고, 사람은 결과를 보고 다시
 * 합칠 수도 있다. 여기서 걷으면 `run.worktree` 가 사라진 폴더를 가리킨 채 남고(setRunWorktree 는
 * 두 번째 쓰기를 거절한다) 배치가 그 경로를 fs.stat 하므로, **그 Run 은 다시는 Task 를 띄울 수
 * 없다.**
 */
export async function integrateWorktrees(
  mergeInto: string,
  paths: string[],
  opts: { reap?: boolean },
  ctx: IntegrateContext
): Promise<Integration> {
  const reap = opts.reap ?? true
  // 1. **저장소가 무언가의 중간이면 아무것도 하지 않는다.** 아래 2의 porcelain 검사는 경로 항목만
  //    내므로 브랜치·상태를 전혀 말하지 않는다 — 작업 트리가 깨끗한 채로 rebase·bisect 중인
  //    저장소와 분리된 HEAD 는 **빈 출력을 낸다.** 그것을 안전으로 읽으면 앱이 그 위에 병합을 건다.
  //
  //    **git 이 막아 주지 않는다.** 임시 저장소에서 실측한 것이다(아래의 거절들은 이제 옆의
  //    integrateGit.test.ts 가 표시 파일마다 임시 저장소로 고정한다):
  //    bisect 중에도, `rebase -i` 가 break 에서 멈춘 상태에서도 `git merge` 는 **성공한다**
  //    (exit 0, "Merge made by the 'ort' strategy"). 그 병합 커밋은 분리된 HEAD 위에 생기고 앱은
  //    "합쳤다"고 보고한다. 사용자가 브랜치를 체크아웃하거나 `rebase --continue|--abort` 를 하는
  //    순간 그 커밋은 도달 불가가 되고, bisect·rebase 세션은 깨진다. 일 자체는 워크트리 브랜치에
  //    남으므로 영구 손실은 아니지만, **사용자의 저장소를 이상한 상태로 두지 않는다**는 이 함수의
  //    규칙에 정면으로 걸린다.
  //
  //    두 가지를 함께 묻는다. 하나로는 못 덮기 때문이다.
  //    - **분리된 HEAD 는 `symbolic-ref --quiet HEAD` 의 실패**로 본다(listBranches 가 이미 그렇게
  //      묻는다). 이것 하나가 bisect·rebase(대화형이든 아니든 HEAD 를 분리한다)·순수 분리 HEAD 를
  //      함께 덮는다. `status --porcelain=v2 --branch` 의 헤더로도 분리는 알 수 있지만 그 헤더는
  //      rebase·bisect·cherry-pick 을 전혀 알려주지 않아 어차피 두 번째 질문이 필요하다.
  //    - **HEAD 를 분리하지 않는 진행 중 작업은 git 디렉터리의 표시 파일**로 본다. cherry-pick·
  //      revert·am·병합은 브랜치 위에 머무르므로 위의 질문에 걸리지 않고, 그 대부분은 충돌이나
  //      staged 변경을 남겨 2가 잡지만 전부는 아니다 — 빈 커밋에서 멈춘 cherry-pick 은 작업
  //      트리가 깨끗한 채 CHERRY_PICK_HEAD 만 남는다. git 자신도 wt_status_get_state 에서 같은
  //      파일들을 본다.
  //
  //    표시 파일의 자리를 `<mergeInto>/.git` 으로 짐작하지 않는다 — 워크트리에서 `.git` 은 파일이고
  //    실제 디렉터리는 <주 저장소>/.git/worktrees/<이름> 이다. 그리고 이 상태들은 워크트리마다
  //    따로다. gitDir()(worktrees/git.ts)이 `--absolute-git-dir` 로 그 자리를 답한다.
  // **git 디렉터리를 먼저 묻는다.** 아래 symbolic-ref 의 실패는 유효한 저장소에서만 "분리됐다"를
  // 뜻하고, 폴더가 사라졌거나 저장소가 아닐 때도 똑같이 실패한다 — 순서가 반대였을 때 이 함수는
  // 그 경우에도 "분리된 HEAD" 라고 말했다. 그 오진이 createWorktree 어댑터 쪽에서 실제로 사람을
  // 헤매게 했고(그쪽 주석), 같은 질문을 같은 방식으로 묻는 이 자리도 같은 순서여야 한다.
  const dir = await gitDir(mergeInto)
  if (!dir)
    return {
      kind: 'human',
      reason:
        `합칠 폴더(${mergeInto})에서 git 을 돌릴 수 없어 워크트리를 합치지 못했습니다 — 그 폴더가 ` +
        `사라졌거나 git 저장소가 아닙니다.`
    }
  const head = await (ctx.git ?? realGit)(['symbolic-ref', '--quiet', 'HEAD'], { cwd: mergeInto })
  if (!head.ok)
    return {
      kind: 'human',
      reason:
        `합칠 폴더(${mergeInto})의 HEAD 가 브랜치를 가리키지 않아 워크트리를 합치지 않았습니다` +
        `(분리된 HEAD — bisect 나 rebase 중일 수도 있습니다). 그 위에 병합하면 만든 커밋이 어느 ` +
        `브랜치에도 남지 않고, 진행 중인 작업이 있다면 그것이 깨집니다. 브랜치를 체크아웃한 뒤 ` +
        `이 Gate 를 해결해 주세요.`
    }
  // 표시 파일과 사람에게 보일 이름. rebase-apply 는 `git am` 도 쓴다.
  const busy = (
    [
      ['rebase-merge', 'rebase'],
      ['rebase-apply', 'rebase 또는 am'],
      ['BISECT_LOG', 'bisect'],
      ['CHERRY_PICK_HEAD', 'cherry-pick'],
      ['REVERT_HEAD', 'revert'],
      ['MERGE_HEAD', '병합']
    ] as const
  ).find(([marker]) => existsSync(path.join(dir, marker)))
  if (busy)
    return {
      kind: 'human',
      reason:
        `합칠 폴더에서 ${busy[1]} 작업이 진행 중(${busy[0]})이어서 워크트리를 합치지 ` +
        `않았습니다. 그 중간에 병합하면 진행 중인 작업이 깨집니다 — 끝내거나 중단한 뒤 이 Gate 를 ` +
        `해결해 주세요.`
    }

  // 2. **추적되는 변경이 남아 있으면 아무것도 하지 않는다.** 병합은 작업 트리에 쓰므로, 그 위에
  //    사용자가 저장하지 않은 일이 있으면 그것을 위험에 놓는다. 그 일을 어떻게 할지는 사람의
  //    판단이고 에이전트가 대신 정할 것이 아니므로 Gate 다("돌릴 수 없을 때만 Gate" 규칙 그대로다).
  //
  //    **isCleanWorktree(worktrees/git.ts)를 쓰지 않는다.** 그쪽은 `--untracked-files=all` 이라
  //    추적되지 않는 파일 하나만 있어도 dirty 라고 답한다 — 그 함수가 답하는 질문은 "이 워크트리를
  //    지워도 되는가"이고 거기서는 그것이 맞다. 여기서 그것을 쓰면 스크린샷 하나 남은 저장소(그것이
  //    보통의 저장소다)에서 자동 Run 이 늘 서 버린다. 추적되지 않는 파일을 통과시켜도 안전한
  //    이유는 git 이 그것을 스스로 지키기 때문이다: 병합이 그 파일을 덮어써야 하면 작업 트리를
  //    **건드리기 전에** 거절한다("untracked working tree files would be overwritten").
  //
  //    `git diff --quiet HEAD` 가 아니라 porcelain 을 읽는 이유는 실패를 구별할 수 있어서다 —
  //    diff 는 "차이가 있다"와 "명령이 실패했다"를 둘 다 0 이 아닌 종료 코드로 내고 git() 은 ok
  //    하나만 준다. 그러면 Gate 의 문장이 사실을 말할 수 없다.
  const status = await (ctx.git ?? realGit)(['status', '--porcelain', '--untracked-files=no'], { cwd: mergeInto })
  if (!status.ok)
    return {
      kind: 'human',
      reason: `합칠 폴더(${mergeInto})의 git 상태를 읽을 수 없어 워크트리를 합치지 못했습니다: ${status.stderr}`
    }
  if (status.stdout !== '')
    return {
      kind: 'human',
      reason:
        `합칠 폴더에 커밋되지 않은 변경이 ${status.stdout.split('\n').length}개 있어 워크트리를 ` +
        `합칠 수 없습니다. 커밋하거나 되돌린 뒤 이 Gate 를 해결해 주세요(추적되지 않는 새 파일은 ` +
        `여기에 세지 않습니다).`
    }

  // 3. 각 워크트리의 브랜치를 알아낸다. `git worktree list` 한 번으로 경로 → 브랜치가 전부 나온다.
  //    listGitWorktrees 는 git() 과 달리 **실패하면 던진다** — 그래서 감싼다.
  let rows: { path: string; branch: string | null }[]
  try {
    rows = await listGitWorktrees(mergeInto)
  } catch (e) {
    return { kind: 'human', reason: `워크트리 목록을 읽을 수 없습니다: ${String(e)}` }
  }
  // 경로 비교는 isSamePath 다 — 한쪽은 createWorktree 가 만들어 Dispatch 에 저장된 값이고 다른
  // 쪽은 git 이 방금 낸 값이라 대소문자나 구분자가 다를 수 있다(둘 다 절대경로이므로 결정적이다).
  const targets = paths.map((p) => ({
    path: p,
    branch: rows.find((r) => isSamePath(r.path, p))?.branch ?? null
  }))
  const unknown = targets.filter((x) => !x.branch)
  if (unknown.length > 0)
    return {
      kind: 'agent',
      // 워크트리가 지워졌거나 HEAD 가 분리된 경우다. 합칠 ref 의 이름을 모르므로 앱은 여기서
      // 할 수 있는 것이 없다 — 그렇다고 없는 것으로 치면 그 의존의 일이 없는 채로 다음 Task 가
      // 뜨고, 그것은 조용히 틀린 결과다.
      reason: `the app could not work out which branch belongs to ${unknown
        .map((x) => x.path)
        .join(', ')} — the worktree may have been removed, or its HEAD may be detached`,
      worktrees: targets
    }

  // 4. merge-tree 가 없으면 **미리 검사할 수 없다.** 검사하지 못하는 것을 낙관하지 않는다 —
  //    낙관해서 진짜 병합을 걸면 충돌할 때 `git merge --abort` 로 되돌려야 하고, 그 되돌리기까지
  //    실패하면 사용자의 저장소가 충돌 상태로 남는다. 그래서 곧바로 에이전트에게 넘긴다.
  if (!(await (ctx.gitAtLeast ?? gitVersionAtLeast)(2, 38)))
    return {
      kind: 'agent',
      reason:
        'this git is older than 2.38, so the app has no way to test a merge without writing to the working tree',
      worktrees: targets
    }

  // 5. 하나씩 **미리 검사한 바로 뒤에 합친다.** 전부 검사하고 전부 합치는 순서가 아닌 이유는
  //    merge-tree 의 기준이 그때의 HEAD 라는 것이다 — 첫 병합이 커밋을 만들면 HEAD 가 움직이고,
  //    그 앞에서 통과했던 두 번째 검사는 낡은 사실이 된다(첫 병합이 가져온 변경 때문에 충돌할 수
  //    있다). 그러면 진짜 병합이 실패하고, 되돌리기에 기대는 바로 그 경로로 들어간다.
  //
  //    검사는 `merge-tree --write-tree` 의 **종료 코드**로 읽는다. remove.ts 의 isBranchMerged 는
  //    같은 명령의 결과 트리를 대상의 트리와 견주지만 그것은 다른 질문("이미 합쳐졌는가", squash
  //    병합 판정)에 답하는 것이다. 여기서 필요한 것은 "충돌하는가"이고 그것이 곧 종료 코드다.
  //
  //    병합 대상은 `HEAD` 다. mergeTarget()(remove.ts)을 쓰지 않는 이유는 그 함수가
  //    branch.<b>.base → origin/HEAD 를 고를 수 있어서다 — 원격 ref 에 합치는 것은 다른 일이다.
  //    이름(`rev-parse --abbrev-ref HEAD`)을 따로 얻지 않는 이유는 **1에서 HEAD 가 브랜치를
  //    가리킴을 이미 보장했으므로** 여기서 `HEAD` 가 곧 "사용자가 지금 서 있는 로컬 브랜치"이고,
  //    그 이름을 다시 문자열로 받아 오면 같은 이름의 태그와 헷갈릴 여지만 생기기 때문이다
  //    (`rev-parse --abbrev-ref HEAD` 는 분리된 HEAD 에서 브랜치 이름이 아니라 `HEAD` 를
  //    돌려주므로, 1의 검사가 없다면 그 문자열을 대상으로 삼는 것 자체가 결함이 된다).
  // 커밋되지 않고 남은 변경의 수. **합치기 전에 센다** — 병합은 대상 폴더를 바꾸지만 원본
  // 워크트리는 건드리지 않으므로 값은 같지만, 세는 시점이 앞이면 병합이 중간에 실패해도 이미
  // 얻은 사실이 남는다.
  //
  // `--porcelain` 의 기본값을 쓴다: 추적되지 않는 파일도 센다. 워커가 새 파일을 만들고 add 하지
  // 않은 것이 정확히 이 경고가 잡아야 하는 경우이고, 커밋 의무의 `git add -A` 도 그것을 담는다.
  // 무시되는 파일(빌드 산출물, node_modules)은 기본적으로 빠진다.
  let uncommitted = 0
  for (const target of targets) {
    const dirty = await (ctx.git ?? realGit)(['status', '--porcelain'], { cwd: target.path })
    const n = dirty.ok && dirty.stdout !== '' ? dirty.stdout.split('\n').length : 0
    if (n > 0) ctx.log(`merge: ${target.path} has ${n} uncommitted change(s) — not merged`)
    uncommitted += n
    // 같은 이름의 태그가 브랜치보다 먼저 잡히는 것을 막으려고 전체 ref 를 쓴다(remove.ts 와 같다)
    const ref = `refs/heads/${target.branch}`
    const probe = await (ctx.git ?? realGit)(['merge-tree', '--write-tree', 'HEAD', ref], { cwd: mergeInto })
    if (!probe.ok)
      return {
        kind: 'agent',
        // **0 이 아닌 것에는 두 가지가 섞여 있다** — 충돌과 "명령이 아예 못 돌았다"(없는 ref,
        // 커밋이 없는 HEAD …). git() 은 ok 하나만 주므로 종료 코드로는 가를 수 없고, 임시
        // 저장소에서 실측한 결과 둘 다 exit 1 이었다(오류가 128 이라는 보장도 없다). 대신
        // **stderr 가 갈라 준다**: 충돌일 때 merge-tree 는 결과를 stdout 에 쓰고 stderr 를
        // 비우며(273바이트/0바이트), 없는 ref 에서는 stdout 이 비고 stderr 에
        // "merge-tree: refs/heads/nope - not something we can merge" 가 온다.
        //
        // 가는 곳은 어느 쪽이든 에이전트다. 가르는 것은 **문장**이다: 실제로는 ref 가 잘못된
        // 것인데 spec 의 첫 문장이 "충돌한다"이면 에이전트는 없는 충돌을 찾아 헤매다 결국
        // `git merge` 를 돌려 진짜 오류를 다시 발견해야 한다. 앱이 아는 것을 그대로 넘긴다.
        reason: probe.stderr
          ? `the app could not test whether ${target.branch} merges into the branch this folder is on — git merge-tree failed: ${probe.stderr}`
          : `git merge-tree says ${target.branch} does not merge cleanly into the branch this folder is on`,
        worktrees: targets
      }
    // `--no-edit` 는 편집기를 막는 것이다. 이 자리에는 사람이 없고, 편집기가 뜨면 그 git 프로세스는
    // git() 의 30초 timeout 까지 서 있다가 죽는다 — 그때 남는 저장소가 곧 병합 중간 상태다.
    //
    // **저장소를 실제로 움직이는 자리다** — mergeInto 의 HEAD 와 index 를 옮긴다. gitWatcher 가
    // 바로 그 둘을 보고 있으므로, 이 병합을 EG §26 에 등록해 두지 않으면 Astera 자신이 방금 만든
    // 변경이 "외부에서 저장소가 바뀌었다"로 기록된다(EG §41-9). `finally` 로 닫는 이유는 아래
    // 실패 분기가 그 안에서 그대로 `return` 하기 때문이다 — try 없이 두면 그 경로로 나갈 때
    // 등록이 영원히 "진행 중"으로 남고, 그날부터 이 프로젝트의 모든 외부 변경이 조용히 삼켜진다.
    const mergeOpId = ctx.gitOp.begin('job-merge', mergeInto)
    try {
      const merged = await (ctx.git ?? realGit)(['merge', '--no-edit', ref], { cwd: mergeInto })
      if (!merged.ok) {
        // 미리 검사가 통과했는데도 실패했다면 충돌이 아닌 이유다(추적되지 않는 파일과의 겹침,
        // index.lock, 훅, 서명). 되돌린 뒤 사람에게 간다 — 에이전트에게 넘기지 않는 이유는 이것이
        // "합치면 충돌한다"가 아니라 "앱이 병합을 돌릴 수 없다"이기 때문이다.
        await (ctx.git ?? realGit)(['merge', '--abort'], { cwd: mergeInto }) // 병합이 시작되지도 않았으면 실패한다 — 무시한다
        // **되돌아갔는지 확인해서 그 사실을 문장에 넣는다.** 앱이 저장소를 어떤 상태로 두었는지를
        // 사용자가 짐작하게 두지 않는다 — 이 경로가 있는 이유가 그것이다.
        const after = await (ctx.git ?? realGit)(['status', '--porcelain', '--untracked-files=no'], { cwd: mergeInto })
        const left =
          after.ok && after.stdout === ''
            ? '합칠 폴더는 병합 전 상태로 되돌렸습니다.'
            : '**합칠 폴더가 병합 중간 상태로 남아 있을 수 있습니다 — git status 로 직접 확인해 주세요.**'
        return {
          kind: 'human',
          reason: `${target.branch} 브랜치를 합칠 폴더에 합치지 못했습니다: ${merged.stderr || merged.stdout}. ${left}`
        }
      }
    } finally {
      ctx.gitOp.end(mergeOpId)
    }
    ctx.log(`scheduler: merged ${ref} into ${mergeInto}`)
    // 합친 워크트리는 여기서 지운다 — **폴더까지. 단 `reap` 일 때만이다**(위 주석: 사람이 누른
    // 병합은 폴더를 남긴다). 예약이 이 자동 정리를 필수로 만들었다: 회차마다
    // 워커 수만큼 워크트리가 생기므로 사람이 손으로 지우는 것은 현실적이지 않다.
    //
    // 지우는 방법은 removeWorktree(core/worktrees/remove.ts)가 안다 — 탐색기의 워크트리 패널이
    // 쓰는 **같은 함수**다. 두 번째 제거 경로를 만들면 위험 경로 검사·사용 중 검사·브랜치 처리가
    // 두 벌이 되고, 한쪽만 고쳐지는 날 이쪽이 폴더를 잘못 지운다. 그 함수가 폴더 자체를
    // (`git worktree remove --force`) 지우고, 비게 된 저장소별 상위 폴더도 rmdir 하고,
    // 레지스트리 항목까지 걷는다.
    //
    // force: true — 합친 뒤 워크트리에 남는 것은 커밋되지 않은 변경과 추적되지 않는 파일뿐이고,
    // 커밋된 일은 방금 합칠 폴더로 들어갔다. 그 대가를 알고 고른 동작이다.
    //
    // **정리 실패가 병합을 망치지 않는다.** 병합은 이미 성공했고 결과물은 합칠 폴더에 있다 —
    // 정리가 안 됐다고 Gate 를 열면 사람이 손쓸 것도 없는 자리에서 파이프라인이 선다. 도는
    // 세션이 그 폴더를 쓰고 있으면 removeWorktree 가 IN_USE 로 던지고 **그것이 맞다**: 살아 있는
    // 프로세스 밑의 폴더는 지우지 않는다. 그때 그 워크트리는 남고 이유는 로그에 남는다.
    if (reap) await ctx.reap(target.path)
  }
  return { kind: 'merged', uncommitted }
}

export interface ReapContext {
  registry: WorktreeStore
  /** The sessions a reap may close in this folder, and whether anything still runs there. */
  sessions: {
    inTree(worktreePath: string): { id: string }[]
    anyRunningIn(worktreePath: string): boolean
    kill(id: string): void
  }
  dispatches(): readonly { sessionId: string; retained?: boolean; outcome?: unknown; endedAt?: string }[]
  isPathInUse(p: string): string | null
  log(m: string): void
  /** Asked right before the folder is removed, after its sessions are closed: a tag of what still
   *  uses it, or null. A tag refuses the removal as IN_USE does. The Host asks the attached app here
   *  (what the app runs itself is invisible to the Host); the app leaves it out. */
  beforeRemove?(worktreePath: string): Promise<string | null>
  /** Test seams; default to WORKTREE_CLOSE_TIMEOUT_MS and 50 ms. */
  closeTimeoutMs?: number
  pollMs?: number
}

/** 워크트리의 세션이 닫히기를 기다리는 상한. pty.kill 은 비동기이고 상태는 exit 이벤트가 와야
 *  바뀐다 — 고정 대기가 아니라 조건을 폴링하고(coordinator 의 waitUntilIdle 과 같은 관례) 이
 *  시간을 넘기면 정리를 건너뛴다. 살아 있는 프로세스 밑의 폴더는 지우지 않는다. */
export const WORKTREE_CLOSE_TIMEOUT_MS = 5_000
/**
 * 워크트리 하나를 폴더째 지운다 — 그 안에서 도는 세션을 먼저 닫고. true = 지워졌다.
 *
 * **두 곳이 이것을 쓴다**: 병합 직후의 자동 정리와 `run-delete --remove-worktrees`. 복제하면
 * "무엇을 닫아도 되는가" 의 답이 두 벌이 되고, 한쪽만 고쳐지는 날 다른 쪽이 살아 있는 세션 밑의
 * 폴더를 지운다.
 *
 * **세션을 먼저 닫는 이유**: 끝난 워커의 세션은 스스로 죽지 않는다 — worker-release 는 코디네이터가
 * 부르는 명령이고 앱이 자동으로 부르는 자리가 없다. 닫지 않으면 removeWorktree 의 isPathInUse 가
 * 늘 IN_USE 를 내고 이 정리는 사실상 한 번도 돌지 않는다.
 *
 * **닫지 않는 두 경우**: 붙잡아 둔 세션(worker-retain — 사람이 살려 두라고 말한 것)과 아직 열려
 * 있는 Dispatch 의 세션(지금 일하는 중이다). 그때는 아무것도 닫지 않고 그 워크트리를 그대로 둔다 —
 * removeWorktree 가 IN_USE 로 거절하는 것이 그 결과다. run-delete 가 retained 에 같은 예외를 둔다.
 */
export async function reapWorktree(worktreePath: string, ctx: ReapContext): Promise<boolean> {
  const inTree = ctx.sessions.inTree(worktreePath)
  const held = ctx.dispatches().some(
    (d) =>
      (d.retained || (!d.outcome && !d.endedAt)) && inTree.some((x) => x.id === d.sessionId)
  )
  if (held) {
    ctx.log(`worktree ${worktreePath} has a held or working session — left alone`)
    return false
  }
  for (const x of inTree) ctx.sessions.kill(x.id)
  // 조건 폴링. 상태가 바뀌는 것을 기다리는 것이지 정해진 시간을 자는 것이 아니다
  const deadline = Date.now() + (ctx.closeTimeoutMs ?? WORKTREE_CLOSE_TIMEOUT_MS)
  while (Date.now() < deadline && ctx.sessions.anyRunningIn(worktreePath))
    await new Promise((r) => setTimeout(r, ctx.pollMs ?? 50))
  const entry = ctx.registry.list().find((w) => isSamePath(w.path, worktreePath))
  if (!entry) {
    ctx.log(`${worktreePath} is not an app worktree — left alone`)
    return false
  }
  try {
    if (ctx.beforeRemove) {
      const busy = await ctx.beforeRemove(worktreePath)
      if (busy !== null) throw new Error(`IN_USE: ${busy}`)
    }
    const removed = await removeWorktree({
      id: entry.id,
      force: true,
      registry: ctx.registry,
      isPathInUse: ctx.isPathInUse
    })
    ctx.log(`removed worktree ${worktreePath} (branch deleted=${removed.branchDeleted})`)
    return true
  } catch (e) {
    ctx.log(`worktree cleanup skipped for ${worktreePath}: ${String(e)}`)
    return false
  }
}

/** The two OrchServerDeps bodies that merge and remove a Run's worktrees, over one context. */
export function worktreeDeps(ctx: {
  integrate(into: string, paths: string[], opts: { reap?: boolean }): Promise<Integration>
  reap(p: string): Promise<boolean>
  log(m: string): void
  /** Test seam; defaults to existsSync. */
  exists?(p: string): boolean
}): {
  mergeWorktrees: NonNullable<OrchServerDeps['mergeWorktrees']>
  removeWorktrees: NonNullable<OrchServerDeps['removeWorktrees']>
} {
  return {
    // `run-merge`(사람이 상세 창에서 누른다)와 `run-delete --merge` 가 부른다.
    // integrateWorktrees 의 'agent'(충돌 → 에이전트에게 넘김)도 여기서는 실패다 — 사람이 결과를
    // 기다리고 있고, 지우는 경로에서는 넘길 Run 자체가 사라지는 중이라 통합 Task 를 붙일 자리가
    // 없다. 두 경우 모두 이유를 그대로 올려 보내 사람이 무엇을 해야 하는지 읽게 한다.
    //
    // **`reap: false`** — 이 두 호출자는 폴더를 남긴다(그 이유는 integrateWorktrees 의 주석).
    //
    // **폴더가 있는지로 거른다 — 레지스트리 등록 여부가 아니다.** "합칠 수 있는가"와 "앱이 지워도
    // 되는가"는 다른 질문이다. 뒤쪽만 레지스트리의 것이다(reapableChildRuns 의 isAppWorktree — 그
    // 판정은 이 이유로 바뀌지 않는다). integrateWorktrees 는 git 자신의 `worktree list`에서 브랜치를
    // 찾으므로, 앱이 만들었지만 아직(또는 더 이상) 레지스트리에 없는 워크트리도 git 에게는 멀쩍이
    // 합칠 수 있는 대상이다 — 오케스트레이터가 스스로 만들어 `worker-start --worktree <path>` 로
    // 띄워 넣은, 살아서 일하고 있는 워크트리가 레지스트리 필터 때문에 조용히 걸러지던 것이 바로
    // 그 결함이었다. 재료 `paths`(runWorktrees, `Dispatch.cwd` 를 본다)에 남을 수 있는 건 이제
    // 하나뿐이다: 폴더 자체가 사라진 경우(통합 병합이 이미 걷어 갔거나 예약 회차가 걷혔다) —
    // 그것만 거른다. 존재 확인은 동기다: 폴더가 없으면 합칠 것이 없고, 있으면 그 뒤는 git 의 일이다.
    mergeWorktrees: async (runCwd, paths) => {
      const alive = paths.filter((p) => (ctx.exists ?? existsSync)(p))
      const gone = paths.filter((p) => !(ctx.exists ?? existsSync)(p))
      if (gone.length > 0)
        ctx.log(`merge: skipping ${gone.length} removed worktree(s): ${gone.join(', ')}`)
      // 남은 것이 없으면 성공이다 — 합칠 것이 없는 것은 실패가 아니고, 여기서 실패로 내면 사람이
      // 손쓸 수 없는 이유로 병합 버튼과 삭제가 막힌다.
      if (alive.length === 0) return { ok: true, merged: [], uncommitted: 0 }
      const r = await ctx.integrate(runCwd, alive, { reap: false })
      return r.kind === 'merged'
        ? { ok: true, merged: alive, uncommitted: r.uncommitted }
        : { ok: false, reason: r.reason }
    },
    // `run-delete --remove-worktrees` 가 부른다. 순차로 지운다 — reapWorktree 가 세션을 닫고
    // 상태가 바뀌기를 기다리므로, 병렬로 돌리면 서로의 폴링이 남의 세션을 기다린다.
    removeWorktrees: async (paths) => {
      const failed: string[] = []
      for (const p of paths) {
        // **이미 없는 폴더는 실패가 아니다.** Dispatch 의 cwd 는 워크트리를 지운 뒤에도 상태에 남으므로
        // 그런 경로가 여기까지 온다 — reapWorktree 는 그것을 "앱 워크트리가 아니다" 로 거절하고 false 를
        // 내는데, 그것을 failed 에 담으면 사용자에게 "이 폴더를 지우지 못했습니다" 로 보고된다.
        // 요청한 끝 상태는 이미 그것이다. mergeWorktrees 가 같은 이유로 같은 판정을 한다.
        if (!(ctx.exists ?? existsSync)(p)) {
          ctx.log(`remove: skipping already removed worktree ${p}`)
          continue
        }
        if (!(await ctx.reap(p))) failed.push(p)
      }
      return { failed }
    }
  }
}
