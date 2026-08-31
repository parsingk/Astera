// The values Work Unit detection deals with.
// node: import 없음 — main 과 core 가 함께 읽는다.
import type { SessionCheck } from '../understanding/types'

/** `SessionCheck` is declared in `core/understanding/types.ts`, not here — a later task puts it on
 *  `WorkRecord`, which the renderer reads, and `src/core/workUnit/**` is not in tsconfig.web.json's
 *  include list. Re-exported here so this module's own callers do not need a second import. */
export type { SessionCheck } from '../understanding/types'

/** Four states, all declared. `completed-candidate` is gone: it meant "the agent stopped and
 *  something changed, but nobody confirmed it", and a declared boundary answers that directly.
 *  `abandoned` is gone with it — a unit that closes with no write evidence is removed, not marked. */
export type WorkUnitStatus = 'active' | 'completed' | 'cancelled' | 'interrupted'

export interface SessionWorkUnit {
  id: string
  sessionId: string
  projectPath: string

  /** What the person wrote after /astera-task. Given, never derived from a transcript message. */
  objective: string
  status: WorkUnitStatus

  startedAt: string
  endedAt?: string

  /** Who ended it, and when. Absent while active. */
  completion?: { source: 'agent' | 'user'; at: string }
  /** Why it was cancelled or interrupted, when a reason was given. */
  reason?: string

  /** What the agent reported running. **The app did not run these** — the value of the field is
   *  that it shows what was not run, which no amount of observation gives us. */
  checks?: SessionCheck[]
  /** The agent's own summary from session-task-complete. Material for the write-up, never parsed. */
  resultSummary?: string

  /** Did this session itself touch a file, read out of its own transcript (hasWriteEvidence in
   *  humanRequest.ts).
   *
   *  Observed changes cannot answer this. They come from comparing git snapshots and land on every
   *  open unit in the project, because git reports what changed and never who changed it. With
   *  several sessions on one project — which is what this app is for — a session that only asked a
   *  question carries the files another session was editing.
   *
   *  A unit that closes without this is **removed rather than recorded**. Optional because units
   *  stored before this field existed have no answer. */
  sawWrite?: boolean

  git: {
    startHead: string | null
    endHead?: string | null
    /** Files **already dirty** when the unit opened. observe counts only files outside this list. */
    baselineDirtyFiles?: string[]
    /** Changes **observed** in this window. Not a claim that this unit made them. */
    observedChangedFiles: string[]
  }

  /** External git changes met during the work (EG §27). "Met", not "made". */
  encounteredExternalGitChangeIds: string[]
}

/** 트랜스크립트를 어디까지 읽었는가 (스펙 §16.3). 세션마다 하나 */
export interface TranscriptCursor {
  sessionId: string
  /** 읽고 있던 파일. 세션이 fork(resume) 되면 달라진다 */
  filePath: string
  /** 다음에 여기서부터 읽는다. 마지막 개행 다음 바이트다 */
  offset: number
  /** 마지막으로 읽었을 때의 파일 크기. 이보다 작아졌으면 잘렸거나 다른 파일이다 */
  sizeAtRead: number
}
