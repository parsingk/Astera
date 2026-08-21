import type { BranchRef } from '../types'

/**
 * The base branch a worktree should start out selected on, or null when no worktree can be created at all.
 *
 * Three cases, in order:
 * - the automatic detection found something → use it, so leaving the picker alone behaves as it always did
 * - detection found nothing but branches exist → the newest one. A repo whose branches are neither
 *   main/master nor pushed to origin (only `develop`, say) is perfectly forkable, and returning an empty
 *   selection there would let creation proceed and die on NO_BASE with the picker sitting right there
 * - neither → null. A repo with no commits yet (a fresh `git init`) has no ref to fork from, and the
 *   caller has to refuse before starting rather than let the attempt fail mid-flight
 *
 * The order of `branches` is trusted as given: listBranches sorts newest commit first.
 */
export function resolveInitialBase(opts: {
  branches: BranchRef[]
  detected: string | null
}): string | null {
  if (opts.detected) return opts.detected
  return opts.branches[0]?.name ?? null
}

/**
 * The base to show selected, given what the user already picked.
 *
 * Keeps their choice when it is still one of the offered branches, so toggling the worktree checkbox off
 * and on does not throw the pick away. Falls back to resolveInitialBase when it is not — which is what
 * happens after the project folder is changed with the modal still open: the pick belongs to the previous
 * repository, is absent from the new branch list, and leaving it in place left the picker showing its
 * "nothing selected" placeholder with no way to tell why.
 *
 * Comparison is by the exact short name, so 'develop' and 'origin/develop' are different bases — they are
 * different refs and can point at different commits.
 */
export function reconcileBaseRef(opts: {
  branches: BranchRef[]
  detected: string | null
  current: string
}): string | null {
  if (opts.current !== '' && opts.branches.some((b) => b.name === opts.current)) return opts.current
  return resolveInitialBase(opts)
}

/**
 * Orders branches for the picker: the current branch, then every remote-tracking one, then the rest of the
 * locals. Within each run the incoming order is kept, and listBranches hands them over newest commit first.
 *
 * Needed because listBranches sorts the whole set by commit date, which interleaves remotes and locals. The
 * picker groups by kind, and a heading is emitted wherever the group changes — so an interleaved list
 * produced "Remote / Local / Remote / Local" repeating down the menu instead of two blocks.
 *
 * Partitioning here rather than in listBranches keeps that function a plain view of the refs: date order is
 * the useful primitive, and how the picker groups them is the picker's business. Nor does it belong in
 * groupRowsOf, which renders the order it is given on purpose so every other Select stays predictable.
 *
 * The current branch is dropped from the local run so it cannot appear twice — it leads the list on its own.
 */
export function orderBranchesForPicker(branches: BranchRef[]): BranchRef[] {
  return [
    ...branches.filter((b) => b.current),
    ...branches.filter((b) => b.remote),
    ...branches.filter((b) => !b.remote && !b.current)
  ]
}

/**
 * 워커의 워크트리가 어느 브랜치에서 갈라져 나올지 정할 수 없는 이유 — 없으면 null.
 *
 * **두 이유를 갈라야 하는 까닭**: 그 판정을 `symbolic-ref` 의 실패 하나로 하던 동안 앱은 폴더가
 * 사라진 경우에도 "HEAD 가 분리됐다"고 말했다. 실제로 일어난 일은
 * `fatal: cannot change to '<경로>': No such file or directory` 였고, 그 문장을 받은 사람은 있지도
 * 않은 분리된 HEAD 를 찾아 헤맸다. 앱이 아는 것과 말하는 것이 다르면 진단이 아니라 미로가 된다.
 *
 * `symbolic-ref` 는 유효한 저장소에서만 "분리됐는가"를 답한다 — 그 경로에서 git 을 돌릴 수 없을
 * 때도 똑같이 실패하므로, 저장소에 닿는지를 **먼저** 물어야 그 답이 뜻을 갖는다.
 *
 * 문장은 영어다. 이 값은 throw 로 올라가 worker-start 의 응답을 거쳐 Gate 의 질문에 그대로 실리고,
 * 그 자리의 다른 코드 문자열(NOT_MANAGED, DIRTY, NO_BASE …)과 같은 계열이라야 읽힌다.
 */
export function workerBaseFailure(opts: {
  repoPath: string
  /** `git rev-parse --git-dir` 가 성공했는가 — 그 경로에서 git 을 돌릴 수 있는가 */
  repoReachable: boolean
  /** `git symbolic-ref --quiet --short HEAD` 가 성공했는가. repoReachable 이 거짓이면 뜻이 없다 */
  onBranch: boolean
  /** 저장소에 닿지 못했을 때 git 이 낸 말 — 원인을 사람이 알 수 있게 문장에 싣는다 */
  stderr?: string
}): string | null {
  if (!opts.repoReachable)
    return (
      `NO_REPO: cannot run git in ${opts.repoPath} — the project folder of this job is gone or is ` +
      `not a git repository${opts.stderr ? `: ${opts.stderr}` : ''}`
    )
  if (!opts.onBranch)
    return `NO_BASE: HEAD is not on a branch (detached) — cannot fork a worker worktree from ${opts.repoPath}`
  return null
}
