// 숨긴 프로젝트의 **기록을 지우는** 순서. 지우는 것은 세션 트랜스크립트(.jsonl)뿐이고, 사용자의
// 프로젝트 폴더는 이 파일의 어떤 경로로도 닿지 않는다.
//
// 디스크와 electron 을 주입받는 이유는 하나다 — 이 동작은 되돌릴 수 없고, "실행 중이면 파일을
// 만지지 않는다" 나 "판정을 통과 못한 경로는 지우지 않는다" 같은 규칙은 결과값이 아니라 **무엇을
// 건드리지 않았는가**로만 확인된다. 실제 배선(shell.trashItem, fs.readdir)은 ipc.ts 에 있다.
import { deletableTranscripts, prunableDirs } from '../core/history/deletion'

export interface DeletionDeps {
  /** 그 경로에서 도는 세션·런이 있으면 이유 태그, 없으면 null */
  inUse: (projectPath: string) => string | null
  targetsOf: (projectPath: string) => Promise<{ files: string[]; dirs: string[]; scanRoots: string[] }>
  trash: (p: string) => Promise<void>
  isEmptyDir: (p: string) => Promise<boolean>
}

export interface DeletionResult {
  deleted: string[]
  /** 지우지 못한 것과 그 이유 — 태그로 보내고 문장은 렌더러가 만든다(worktrees 쪽과 같은 관례) */
  skipped: { projectPath: string; reason: string }[]
}

export async function deleteProjectHistory(
  projectPaths: string[],
  deps: DeletionDeps
): Promise<DeletionResult> {
  const deleted: string[] = []
  const skipped: { projectPath: string; reason: string }[] = []

  for (const projectPath of projectPaths) {
    // 무엇보다 먼저. 도는 세션이 쓰고 있는 파일을 치우면 그 세션의 기록이 중간에서 끊긴다
    const busy = deps.inUse(projectPath)
    if (busy) {
      skipped.push({ projectPath, reason: busy })
      continue
    }

    const { files, dirs, scanRoots } = await deps.targetsOf(projectPath)
    let failed = false
    for (const f of deletableTranscripts(files, scanRoots)) {
      try {
        await deps.trash(f)
      } catch {
        failed = true
      }
    }
    if (failed) {
      // 남은 파일이 있는 채로 디렉터리를 치우려 들지 않는다 — 지우지 못한 기록까지 함께 잃는다
      skipped.push({ projectPath, reason: 'FAILED' })
      continue
    }

    // 파일이 다 빠진 슬러그 디렉터리 치우기. 비었는지 **묻고 나서** 지운다 — 이 판정이 고르는 것은
    // "스캔 루트의 직계 자식"뿐이지만, 그 안에 무언가 남아 있다면 그것은 우리가 모르는 파일이다.
    for (const d of prunableDirs(dirs, scanRoots)) {
      try {
        if (await deps.isEmptyDir(d)) await deps.trash(d)
      } catch {
        // 빈 디렉터리가 남는 것은 목록에 아무것도 만들지 않는다. 기록은 이미 지워졌으므로 성공이다
      }
    }

    // 지울 기록이 없었던 경우도 여기로 온다. 부르는 쪽은 이 목록을 숨김 목록에서 빼는데, 기록이
    // 없는 항목이야말로 그 목록에 남아 있을 이유가 없다
    deleted.push(projectPath)
  }

  return { deleted, skipped }
}
