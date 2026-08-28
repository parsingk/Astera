// 롤링이 재개 직전에 물어보는 훅(RollingDeps.resumeText/CodexRollingDeps.resumeText)의 구현.
//
// **packet 을 프롬프트 자리에 직접 실을 수 없는 이유는 배선(rolling.ts/codexRolling.ts) 쪽에 있다.**
// codex 는 프롬프트를 CLI 인자로 넘기고 sanitizeResumePrompt(core/sessions/commands.ts)가
// `["&|<>^%]`를 지운 뒤 모든 공백을 하나로 접어, 여러 줄 packet 이 뭉개진 한 줄이 된다. claude 는
// PTY 에 타이핑하므로 줄바꿈마다 Enter 가 눌려 packet 이 중간에 스스로 제출된다. 그래서 packet 은
// 워커가 이미 아는 spec 파일(Dispatch.specPath)에 적어 두고, 프롬프트는 그 파일을 다시 읽으라는
// 한 줄로 좁힌다 — 경로를 담지 않으므로 따옴표 문제가 아예 없다.
//
// 이 파일은 순수하지 않다(fs 를 쓴다) — 그래서 main 쪽에 있다. 조립 자체(Checkpoint, 서식)는
// core/orchestration 의 순수 모듈(checkpoint.ts, resumeSection.ts)이 이미 하고, 여기는 그 결과를
// 어디서 읽고(OrchState 에서 열린 Dispatch를 찾고, git 을 읽고) 어디에 쓰는지(spec 파일)만 맡는다.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildCheckpoint } from '../../core/orchestration/checkpoint'
import { formatResumeNote, formatResumeSection } from '../../core/orchestration/resumeSection'
import { formatTabResume } from '../../core/orchestration/tabResume'
import type { OrchState } from '../../core/orchestration/state'
import type { LastCommand, Provider, TranscriptMessage } from '../../core/types'
import { readGitSummary, type GitSummaryDeps } from '../gitSummary'
import { LAUNCH_FORBIDDEN } from './coordinator'
import { parseTranscriptForResume, type TranscriptResumeMaterial } from '../../core/history/parser'
import { parseCodexForResume } from '../../core/history/codexParser'

export interface ResumePacketDeps {
  /** git 실행 어댑터. readGitSummary(main/gitSummary.ts)의 GitSummaryDeps.git 을 그대로 통과시킨다 —
   *  테스트 주입용이고, 넘기지 않으면 실제 git 을 쓴다. */
  git?: GitSummaryDeps['git']
  /** 현재 시각(ISO). 넘기지 않으면 실제 시계를 쓴다 — 결정론이 필요한 테스트만 주입한다. */
  now?(): string
  /** 쓰기 실패 진단 로그. 넘기지 않으면 아무 것도 하지 않는다(다른 모듈들의 log? 와 같은 관례) —
   *  packet 을 못 만들어도 재개 자체는 막지 않으므로, 이 로그가 없어도 기능은 그대로 동작한다. */
  log?(message: string): void
  /** spec 파일을 읽는 방법. 테스트 전용 주입점이다 — ENOENT 가 아닌 읽기 실패(파일 잠금, EMFILE 등)
   *  는 실제 OS 조건으로 결정론적으로 재현할 수 없어서 여기로 갈아끼운다. 넘기지 않으면 실제
   *  fs.readFile 을 쓴다. */
  readFile?(path: string): Promise<string>
  /** spec 파일을 쓰는 방법. readFile? 과 같은 이유의 테스트 전용 주입점이다 — **중간에 끊긴
   *  쓰기**(디스크가 차거나 프로세스가 죽는 순간)는 실제 fs 로 결정론적으로 만들 수 없는데,
   *  writeAtomic 이 막으려는 사고가 바로 그것이다. 넘기지 않으면 실제 fs.writeFile 을 쓴다.
   *  받는 경로는 **임시 파일 경로**다(writeAtomic 이 rename 으로 갈아 끼운다). */
  writeFile?(path: string, content: string): Promise<void>
}

/** spec 파일에 붙이는 절의 표제. buildSpecFile(coordinator.ts)의 "## Project knowledge"·
 *  "## Commit obligation"·"## Reporting obligation" 과 같은 모양(H2 + "assembled by the app —
 *  do not delete")을 따른다 — 이 절도 앱이 조립해 붙인 것이고 지우면 안 된다는 뜻이 같다. */
const HEADING = '## Resume briefing (assembled by the app — do not delete)'

/** 재개가 반복되어도 절이 쌓이지 않게 한다. **이 절은 항상 파일의 마지막**이라는 전제로,
 *  이전에 붙은 적이 있으면(표제가 있으면) 그 지점부터 끝까지를 잘라내고 새 절로 바꿔 끼운다.
 *  buildSpecFile 이 쓰는 것과 같은 `\n---\n## <표제>` 구분자를 찾는 표시로 쓴다. */
function upsertResumeSection(existing: string, section: string): string {
  const marker = `\n---\n${HEADING}`
  const idx = existing.indexOf(marker)
  const base = (idx === -1 ? existing : existing.slice(0, idx)).replace(/\n+$/, '')
  const block = `---\n${HEADING}\n\n${section}\n`
  return base === '' ? block : `${base}\n\n${block}`
}

/** spec 파일을 통째로 갈아 끼운다. **임시 파일에 쓴 뒤 rename 한다** — `fs.writeFile` 은 대상을
 *  제자리에서 truncate 하므로, 그 사이에 쓰기가 실패하거나 프로세스가 죽으면 파일은 잘린 채로
 *  남고 되돌려 줄 사람이 없다: 보고 의무·커밋 의무·Task 지시문이 한꺼번에 사라지고, 이 함수의
 *  catch 는 로그만 남긴다. 앞선 fix round 가 **읽는 쪽**에서 막은 것과 같은 사고가 쓰는 쪽으로
 *  들어온 것이다.
 *
 *  모양은 이 저장소가 망가지면 안 되는 파일에 이미 쓰는 것을 그대로 따른다 —
 *  `OrchestrationStore.writeNow`(main/orchestration/store.ts)와 `RunConfigStore.save`
 *  (main/runConfigStore.ts)의 `<파일>.<uuid>.tmp` → rename 이다. uuid 를 끼우는 이유도 같다:
 *  두 쓰기가 겹쳐도 서로의 임시 파일을 밟지 않는다.
 *
 *  rename 이 실패하면 임시 파일이 남는다 — 지우려 시도하되 그 실패는 삼킨다(원래 오류를 가리면
 *  안 된다). 남더라도 이 함수를 쓰는 두 디렉터리 — spec 디렉터리와 tab-resume 디렉터리 —
 *  모두 앱 시작마다 통째로 비워지므로(ipc.ts) 누적되지 않는다. */
async function writeAtomic(
  filePath: string,
  content: string,
  writeFile: (path: string, content: string) => Promise<void>
): Promise<void> {
  const tmp = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, content)
    await fs.rename(tmp, filePath)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/** 재개 프롬프트 자리에 실을 한 줄. **경로는 담지 않는다**(위 헤더의 이유 — sanitizer 가 따옴표를
 *  지운다) 대신 보고 명령은 담는다.
 *
 *  **보고 명령을 인라인으로 다시 적는 이유.** 이 줄이 정적 문자열이던 동안은 spec 파일을 가리키기만
 *  했다 — 같은 의무를 세 곳에 다른 문구로 적지 않으려는 선택이었다. 그런데 이 줄은 파일을 다시
 *  읽으라고 **요청**할 수 있을 뿐 강제할 수 없다: 재개된 에이전트가 기억으로 이어가기로 하면 보고
 *  명령을 어디서도 다시 보지 못하고, 그러면 그 Task 는 영원히 닫히지 않는다(SPEC §9.2 의 네 번째
 *  줄). 이 자리에 있던 Phase 1b 의 프롬프트(coordinator.ts 의 `rollPrompt`)는 그 명령을 인라인으로
 *  들고 있었으므로, 그것을 빼는 것은 순손실이었다.
 *
 *  세 곳의 문구가 갈리는 문제는 **명령의 모양**을 같게 유지해 해결한다 — SPEC §9.2 가 요구하는 것도
 *  낱말이 아니라 그것이다(같은 커맨드, 같은 인자). `buildSpecFile` 의 Reporting obligation 과
 *  `formatResumeSection` 의 REPORT WHEN DONE 과 `rollPrompt` 가 모두 같은
 *  `astera send --type worker_done --task-id … --dispatch-id …` 를 쓴다.
 *
 *  taskId·dispatchId 는 재개 뒤에도 유효하다 — `rekeyDispatch` 는 sessionId·accountId 만 옮기고
 *  Dispatch.id 는 바꾸지 않는다. 둘 다 앱이 만든 hex id 라 `LAUNCH_FORBIDDEN` 에 걸릴 문자가 없지만,
 *  그래도 반환 전에 검사한다(아래 계약). */
function resumeLine(a: { taskId: string; dispatchId: string }): string {
  return (
    'Continue this task: re-read your spec file for the resume briefing the app just appended, ' +
    'then carry on from where the work already stands. When it is finished, report exactly once ' +
    `with astera send --type worker_done --task-id ${a.taskId} --dispatch-id ${a.dispatchId}.`
  )
}

/**
 * sessionId 로 열린 Dispatch 를 찾아 Checkpoint 를 조립하고, 그 spec 파일에 재개 절을 적어 넣은 뒤
 * 프롬프트 자리에 실을 한 줄을 돌려준다.
 *
 * **실패는 전부 null 로 저하한다 — 절대 던지지 않는다.** 이 함수가 null 을 돌리면 부르는 쪽
 * (rolling.ts/codexRolling.ts)은 그 자리에서 이미 쓰던 고정 문장(chain.prompt)으로 재개한다 —
 * packet 을 못 만들었다고 재개 자체를 막지 않는다: 인계가 얇은 것은 작은 손해이고, 재개가 죽는 것은
 * 큰 손해다. `readGitSummary` 뒤부터 반환까지 전체를 하나의 try 로 감싸는 이유가 이것이다 —
 * `buildCheckpoint`·`formatResumeSection`(core/orchestration 의 순수 모듈)이 오늘 던지지 않는다는
 * 것을 이 파일이 신뢰하고 그 경계를 얇게 두면, 그 모듈이 나중에 바뀌었을 때 이 함수가 거부된
 * Promise 를 돌려 부르는 쪽의 fire-and-forget 호출(`void this.resumeInPlace(...)` 등)에서 처리되지
 * 않는 예외가 될 수 있다.
 *   - 그 세션에 열린 Dispatch 가 없다(사용자 탭 세션 — Job 워커가 아니다), 또는 specPath 가 없다:
 *     조용히 null. 이것은 실패가 아니라 "이 기능이 적용될 자리가 아니다"이므로 로그를 남기지 않는다.
 *   - git 을 읽을 수 없다: readGitSummary 자체가 null 을 돌리고, buildCheckpoint 는 그 null 을 받아
 *     git 관련 칸만 비운 채 나머지를 그대로 조립한다 — packet 은 계속 만들어진다.
 *   - spec 파일이 **아직 없다**(ENOENT) — 이번이 첫 재개이거나 아직 한 번도 쓰이지 않았다: 기존
 *     내용이 없는 것으로 보고 새 절만 담아 만든다.
 *   - spec 파일 읽기가 **다른 이유로** 실패한다(파일 잠금, EMFILE, 클라우드 동기화 recall 등): 이건
 *     "내용이 없다"가 아니다 — 있는 내용을 모른 채 덮어쓰면 원래 Task 지시문을 통째로 지운다. 그래서
 *     이 경우는 쓰기를 시도하지 않고 곧바로 null 로 저하한다(파일은 손대지 않는다).
 *   - spec 파일을 쓸 수 없다(디스크가 찼다, 경로가 사라졌다, 쓰다가 끊겼다): 로그를 남기고 null.
 *     **원본은 어느 경우에도 잘리지 않는다** — 쓰기는 임시 파일에 하고 rename 으로 갈아 끼운다
 *     (writeAtomic).
 *   - Checkpoint 조립이나 서식화가 던진다(오늘은 일어나지 않지만, 위 이유로 대비해 둔다): 로그를
 *     남기고 null.
 *   - 반환할 문장이 LAUNCH_FORBIDDEN 에 걸린다: null. 담기는 값은 앱이 만든 hex id 둘뿐이라 오늘은
 *     걸릴 수 없지만, codex 의 sanitizer 가 지우는 문자를 스스로도 검사해 두는 것은 이 함수의 계약이다.
 */
export async function buildResumePacket(
  sessionId: string,
  state: OrchState,
  deps: ResumePacketDeps = {}
): Promise<string | null> {
  const dispatch = state.dispatches.find((d) => d.sessionId === sessionId && !d.endedAt)
  if (!dispatch || !dispatch.specPath) return null

  try {
    const git = await readGitSummary(
      dispatch.cwd,
      deps.git ? { git: deps.git } : undefined
    ).catch(() => null)
    const now = deps.now?.() ?? new Date().toISOString()
    const checkpoint = buildCheckpoint(state, { dispatchId: dispatch.id, git, now })
    if (!checkpoint) return null // Task 나 Run 이 사라졌다 — 열린 Dispatch 라면 있을 수 없지만 방어적으로

    const section = formatResumeSection(checkpoint)

    // "파일이 없다"(ENOENT — 첫 재개)만 "기존 내용 없음"으로 본다. 그 밖의 읽기 실패는 내용을 모르는
    // 것이지 없는 것이 아니므로, 여기서 던져 아래 catch 로 보내 쓰기 자체를 건너뛴다 — 알 수 없는
    // 상태 위에 덮어써서 원본 지시문을 지우는 것보다 재개 한 번을 저하시키는 편이 훨씬 싸다.
    const readFile = deps.readFile ?? ((p: string) => fs.readFile(p, 'utf8'))
    let existing = ''
    try {
      existing = await readFile(dispatch.specPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
    }
    const writeFile = deps.writeFile ?? ((p: string, c: string) => fs.writeFile(p, c, 'utf8'))
    await writeAtomic(dispatch.specPath, upsertResumeSection(existing, section), writeFile)

    const line = resumeLine({ taskId: checkpoint.taskId, dispatchId: checkpoint.dispatchId })
    if (LAUNCH_FORBIDDEN.test(line)) return null
    return line
  } catch (err) {
    deps.log?.(`resume packet failed dispatch=${dispatch.id}: ${String(err)}`)
    return null
  }
}

/**
 * 살아 있는 세션에 덧붙일 한 줄. **spec 파일을 건드리지 않는다.**
 *
 * **왜 모양이 둘인가.** `SPEC §11.5` 의 기준은 `--resume` 이 호출되는가 하나다: 호출되면 프로세스가
 * 새것이고 작업을 이어 주는 것이 transcript 파일 하나뿐이므로 구조화된 인계가 값을 낸다. 호출되지
 * 않으면 같은 프로세스가 계속 도는 것이고 **떨어뜨린 것이 없으니 인계할 것도 없다.** 이 앱에서
 * `--resume` 을 부르는 재개는 두 자리(codex 의 `roll()`, claude 의 `roll()`)이고, 부르지 않는
 * 재개는 네 자리(claude 의 `resumeInPlace`·idle nudge·리셋 앵커, codex 의 `resumeInPlace`)다 —
 * 그리고 **Job 워커의 체인은 계정이 하나라서 양쪽 워커 모두 기본적으로 `resumeInPlace` 를 탄다.**
 * 즉 이 함수가 워커의 정상 경로다. 그쪽에 전체 packet 을 주면 대화가 온전한 에이전트에게 방금
 * 리셋된 할당량으로 이미 아는 것을 재구성시키는 일이 된다.
 *
 * 어느 모양을 쓸지는 **코디네이터가 고른다**(자기가 어느 경로인지 아는 유일한 쪽이다) — 배선의
 * `resumeText(sessionId, form)` 두 번째 인자가 그 선택이고, 이 파일은 form 을 해석하지 않는다.
 *
 * 실패는 전부 `null` 이다 — 그러면 부르는 쪽은 덧붙이지 않고 기존 문장만 쓴다. git 을 못 읽으면
 * 확인한 것이 하나도 없으므로 `formatResumeNote` 자체가 `null` 을 내고, **그 폐기는 로그로 남는다**
 * (아래 주석 — 소리 없이 사라지는 노트가 이 함수의 실제 사고였다).
 */
export async function buildResumeNote(
  sessionId: string,
  state: OrchState,
  deps: ResumePacketDeps = {}
): Promise<string | null> {
  const dispatch = state.dispatches.find((d) => d.sessionId === sessionId && !d.endedAt)
  if (!dispatch) return null // Job 워커가 아니다(사용자 탭 세션)

  try {
    const git = await readGitSummary(
      dispatch.cwd,
      deps.git ? { git: deps.git } : undefined
    ).catch(() => null)
    const now = deps.now?.() ?? new Date().toISOString()
    const checkpoint = buildCheckpoint(state, { dispatchId: dispatch.id, git, now })
    if (!checkpoint) return null
    const note = formatResumeNote(checkpoint)
    if (note === null) {
      // 유일하게 남은 폐기 경로다 — **소리 없이 버리지 않는다.** git 을 못 읽었다는 뜻이고,
      // 그러면 확인한 것이 하나도 없어 할 말도 없다(formatResumeNote 의 계약).
      deps.log?.(`resume note skipped dispatch=${dispatch.id}: no git summary to report`)
      return null
    }
    // **여기서 LAUNCH_FORBIDDEN 을 검사하지 않는다.** packet 쪽 한 줄과 달리 이 문자열은 **파일
    // 이름을 담는다** — `docs/R&D notes.md` 하나가 저장소에 있으면 `&` 때문에 검사가 걸리고, 노트가
    // 통째로 버려진다. 그 저장소에서는 이 Phase 의 claude 쪽 가치 전부가 흔적도 없이 사라진다.
    //
    // 검사가 지킬 것도 이 경로에는 없다: 'update' 를 묻는 자리는 네 곳이고(rolling.ts 의
    // resumeInPlace · idle nudge · 리셋 앵커, 그리고 codexRolling.ts 의 resumeInPlace) **넷 다
    // 살아 있는 PTY 에 타이핑한다.** codex 쪽 자리가 생겼어도 결론이 그대로인 이유가 그것이다 —
    // 이 문자열은 argv 로 가지 않으므로 codex 의 인자 sanitizer(sanitizeResumePrompt)가 도는 자리가
    // 아니다. 지키는 것 없이 파일 이름 한 글자로 기능을 끄는 검사는 순손실이다.
    //
    // **이 문자열이 argv 로 가는 경로가 생기는 날의 처방을 여기 적어 둔다:** 그때도 노트를 버리는
    // 것이 아니라 걸리는 **파일 이름만** 목록에서 걸러야 한다. 노트를 버리면 아무것도 남지 않고,
    // 이름을 걸러내면 나머지 증거는 남는다.
    return note
  } catch (err) {
    deps.log?.(`resume note failed dispatch=${dispatch.id}: ${String(err)}`)
    return null
  }
}

/** buildTabResumeText 의 의존성. buildResumePacket/buildResumeNote 와 달리 OrchState 를 보지
 *  않는다 — 탭 세션은 Dispatch 가 없으므로 볼 State 가 없다. 대신 cwd 와 transcript 경로를 직접
 *  받는다. */
export interface TabResumeDeps {
  /** 그 세션의 작업 폴더. **코디네이터가 아는 값이므로 인자로 받는다** — 이 함수가 체인 내부를
   *  들여다보게 하면 core/main 경계가 흐려지고, claude·codex 두 코디네이터가 각자 다른 방법으로
   *  같은 값을 넘길 여지가 생긴다. */
  cwd: string
  /** 그 세션의 현재 대화 파일 경로. 모르면(아직 못 찾았거나 이 provider 가 그런 파일을 남기지
   *  않으면) null — 그때는 git 만으로 시도한다(아래 buildTabResumeText 의 계약). */
  transcriptPath: string | null
  /** 그 대화 파일이 어느 provider 의 형식인지. `readTranscript` 의 기본값을 고르는 데만 쓴다
   *  (아래) — claude·codex 두 코디네이터가 각자 자기 형식의 경로를 넘기므로, 어느 파서로 읽을지는
   *  호출하는 쪽이 이미 안다. 이 값 자체를 판정하는 것은 이 함수의 일이 아니다. */
  provider: Provider
  /** git 실행 어댑터. ResumePacketDeps.git 과 같은 관례 — 테스트 주입용이고, 넘기지 않으면 실제
   *  git 을 쓴다. */
  git?: GitSummaryDeps['git']
  /** 폐기 진단 로그. 넘기지 않으면 아무 것도 하지 않는다. **폐기를 소리 없이 버리지 않는다** —
   *  buildResumeNote 의 JSDoc 이 적어 둔 이유와 같다: 소리 없이 사라지는 브리핑이 이 기능의
   *  실제 사고다. */
  log?(message: string): void
  /** 대화 파일을 한 번 읽어 다섯(제목·요청·손댄 파일·꼬리·마지막 명령)을 뽑는 방법. 테스트 전용 주입점이다.
   *  넘기지 않으면 `provider` 에 따라 parseTranscriptForResume(claude, core/history/parser.ts) 나
   *  parseCodexForResume(codex, core/history/codexParser.ts)를 쓴다 — codex rollout 은 claude
   *  transcript 와 레코드 모양이 달라 같은 파서로 읽을 수 없다(제목·손댄 파일 레코드가 없다: 그
   *  둘은 항상 비어 온다). */
  readTranscript?(path: string): Promise<TranscriptResumeMaterial>
  /** Task 7 — 'handover' 브리핑을 적을 디렉터리. **'update' 에는 쓰이지 않는다**(그 폼은 파일을
   *  건드리지 않는다 — 아래 buildTabResumeText 의 계약). Job 워커의 spec 파일과 달리 탭 세션에는
   *  기존에 쓰던 파일이 없으므로 어디에 쓸지 자체가 이 함수 밖에서 결정되는 값이다 — 코디네이터가
   *  cwd 를 넘기는 것과 같은 이유(위 cwd 필드의 JSDoc): 이 함수가 main 배선(userData 경로 등)을
   *  들여다보게 하면 core/main 경계가 흐려진다. 실제 값은 main/ipc.ts 가 정한다(프로젝트 폴더가
   *  아니라 앱 데이터 폴더 — 그 이유는 이 파일 아래 buildTabResumeText 의 JSDoc). */
  dir: string
  /** 파일을 쓰는 방법. ResumePacketDeps.writeFile 과 같은 이유의 테스트 전용 주입점이다 — 중간에
   *  끊긴 쓰기를 결정론적으로 재현한다. 넘기지 않으면 실제 fs.writeFile 을 쓴다. 받는 경로는
   *  임시 파일 경로다(writeAtomic 이 rename 으로 갈아 끼운다). 'update' 폼에서는 쓰이지 않는다. */
  writeFile?(path: string, content: string): Promise<void>
}

/**
 * 탭 세션(Job Dispatch 가 없는 일반 세션)용 재개 프롬프트 문자열. buildResumePacket/buildResumeNote
 * 가 Job 워커를 위해 하는 일과 같은 자리다.
 *
 * **Task 7 — 'handover' 는 이제 파일에 쓰고 한 줄만 돌려준다.** 계획 문서는 원래 "탭용 브리핑은
 * 파일을 만들지 않고 프롬프트에 인라인으로 싣는다"고 정했었지만, 그 선택은 이 파일 머리말이 이미
 * 반대로 정해 둔 것과 충돌했다 — claude 는 PTY 에 타이핑하므로 여러 줄 브리핑의 줄바꿈마다 Enter가
 * 눌려 브리핑이 스스로 조각조각 제출되고, codex 는 CLI 인자를 sanitizeResumePrompt 가 한 줄로
 * 접어 구조를 뭉갠다. 그래서 이제 Job 워커와 같은 모양을 쓴다: 조립된 브리핑은 `deps.dir` 아래
 * `<sessionId>.md` 하나에 통째로 쓰고(세션당 파일 하나, 재개할 때마다 덮어쓴다 — 이력을 쌓지
 * 않는다), 프롬프트 자리에는 그 파일을 가리키는 한 줄만 싣는다. spec 파일과 달리 보존할 기존
 * 내용이 없으므로(Job 의 Task 지시문에 해당하는 것이 탭 세션에는 없다) upsertResumeSection 같은
 * 절 관리 없이 매번 그대로 갈아 끼운다. **'update' 는 그대로다** — 살아 있는 세션에 얹는 한 줄이라
 * 파일을 전혀 건드리지 않는다.
 *
 * **대화 파일은 한 번만 읽는다.** 제목·최근 요청·손댄 파일·꼬리·마지막 명령 다섯을 각각 다른
 * 함수로 읽으면 같은(수십 MB 일 수 있는) 파일을 다섯 번 훑는다 — parseTranscriptForResume(claude)
 * 나 parseCodexForResume(codex) 하나가 그 다섯을 한 번의 스트리밍으로 뽑는다.
 *
 * **읽는 파서는 `deps.provider` 가 고른다.** codex rollout 은 claude transcript 와 레코드 모양이
 * 달라 같은 파서로 읽을 수 없다 — codex 쪽은 대화 제목·손댄 파일·마지막 명령 레코드가 아예 없어
 * 그 셋을 항상 비운 채로 돌아온다(parseCodexForResume 의 JSDoc). 손댄 파일이 비면 아래에서 git
 * 변경 목록으로 내려가므로 손실은 없다.
 *
 * **'update' 는 대화 파일을 아예 읽지 않는다.** formatTabResume 의 'update' 모양은 git 상태만
 * 쓰고 title·requests·editedFiles·tail 은 버린다(§11.5 — 대화가 온전한 세션에는 꼬리를 다시 실을
 * 필요가 없다) — 그럴 값을 위해 큰 파일을 훑는 것은 순수 낭비다.
 *
 * 손댄 파일은 대화의 `file-history-snapshot` 레코드에서 먼저 찾고, 그 레코드가 한 번도 없으면(구
 * 버전 세션, 혹은 아직 파일을 건드리지 않은 세션) git 의 변경 목록으로 내려간다 — 계획 문서의
 * 재료 표가 정한 순서다.
 *
 * **LAUNCH_FORBIDDEN 을 여기서 검사하지 않는다 — 두 폼의 이유가 갈린다.** 'update' 가 돌려주는
 * 것은 여전히 **사용자가 실제로 쓴 텍스트와 파일 경로**를 담은 문장이다 — 제목·요청 하나에
 * 따옴표나 `&`가 있는 것은 예삿일이고, 그때마다 버리면 buildResumeNote 의 JSDoc 이 "순손실"이라
 * 부른 바로 그 사고를 반복하는 것이다. 'handover' 가 돌려주는 것은 이제(Task 7) 그 텍스트가 아니라
 * `dir`·`sessionId` 로 지은 파일 경로 하나뿐인 짧은 포인터 한 줄이다 — buildResumePacket 의
 * resumeLine 과 같은 모양이지만, resumeLine 은 앱이 만든 hex id 만 담아 걸릴 문자가 없는 반면 이
 * 줄은 실제 파일시스템 경로를 담는다. 검사하지 않는 이유는 그래도 같다: 드문 사용자 이름
 * 문자(`&` 등) 하나 때문에 브리핑 전체를 버리는 대가가, 지키는 이득보다 크다.
 *
 * **이 문자열이 argv 로 가는 자리는 이미 둘이다, 그리고 둘의 처방이 다르다.** `resumePrompt`
 * 자리(codex 의 `--resume` 뒤)는 buildCodexCommand 가 sanitizeResumePrompt 를 스스로 돌려 왔다 —
 * 이 함수가 그 경계를 미리 검사할 이유가 없었던 것이 그래서다. Smart Resume 의 백지 재개가 같은
 * 문자열을 `initialPrompt` 로도 실어 보내면서 두 번째 자리가 생겼는데, `buildCodexCommand` 는
 * `initialPrompt` 를 스스로 sanitize 하지 않는다(그 필드의 JSDoc 이 이유를 적어 둔다 — 다른
 * caller 인 오케스트레이션 코디네이터는 자신이 만든 spec 파일 포인터가 조용히 망가지지 않도록
 * 거부로 그 경계를 지킨다). 그래서 그 자리의 호출부(codexRolling.ts 의 백지 재개)가 넘기기
 * 직전에 sanitizeResumePrompt 를 스스로 적용한다 — "이미 갖고 있다"가 아니라 그 호출부가 새로
 * 갖췄다는 차이는 있지만, 이 함수가 미리 검사해 통째로 버릴 이유가 아니라는 결론은 그대로다.
 * **'handover' 의 새 포인터 한 줄에서 이 sanitize 가 실제로 하는 일은 연속 공백을 하나로 접는
 * 것뿐이다** — 사용자 이름에 연속된 공백이 있는 드문 경우가 아니면 경로는 그대로 살아남는다.
 *
 * 실패는 전부 `null` 이다 — 부르는 쪽은 기존 고정 문장으로 저하한다. 폐기는 항상 로그로 남는다.
 */

/** 재개 프롬프트 자리에 실을 한 줄. resumeLine(Job 쪽, 위)과 같은 어투이되, 가리킬 taskId·
 *  dispatchId 가 없으므로(탭 세션에는 Dispatch 가 없다) 대신 방금 쓴 파일 경로를 담는다. 보고
 *  명령이 없는 이유도 같다 — worker_done 을 기다리는 Task 가 탭 세션에는 없다. */
function tabResumeLine(filePath: string): string {
  return (
    'Continue this session: re-read the resume briefing the app just wrote to ' +
    `${filePath}, then carry on from where the work already stands.`
  )
}

export async function buildTabResumeText(
  sessionId: string,
  form: 'handover' | 'update',
  deps: TabResumeDeps
): Promise<string | null> {
  try {
    const git = await readGitSummary(deps.cwd, deps.git ? { git: deps.git } : undefined).catch(() => null)

    let title: string | null = null
    let requests: string[] = []
    let editedFiles: string[] = []
    let tail: TranscriptMessage[] = []
    let lastCommand: LastCommand | null = null
    if (form === 'handover' && deps.transcriptPath) {
      const read =
        deps.readTranscript ??
        (deps.provider === 'codex' ? parseCodexForResume : parseTranscriptForResume)
      const material = await read(deps.transcriptPath)
      title = material.title
      requests = material.requests
      editedFiles = material.editedFiles
      tail = material.tail
      lastCommand = material.lastCommand
    }
    if (editedFiles.length === 0 && git) editedFiles = git.changed

    const text = formatTabResume(
      { cwd: deps.cwd, title, requests, editedFiles, git, tail, lastCommand },
      form
    )
    if (text === null) {
      // formatTabResume 이 null 을 돌리는 유일한 이유는 "확인한 것도 대화 흔적도 없다"다(그 함수의
      // 계약) — buildResumeNote 와 같은 이유로 여기서도 소리 없이 버리지 않는다.
      deps.log?.(`tab resume skipped session=${sessionId} form=${form}: nothing to report`)
      return null
    }
    if (form === 'update') return text // 살아 있는 세션에 얹는 한 줄 — 파일을 건드리지 않는다

    // 'handover': 조립된 브리핑을 세션당 파일 하나(<sessionId>.md)에 통째로 갈아 끼우고(재개마다
    // 덮어쓴다 — 이력을 쌓지 않는다), 프롬프트 자리에는 그 파일을 가리키는 한 줄만 싣는다(위
    // 함수 JSDoc — Task 7). 쓰기 실패는 이 try 블록의 catch 로 떨어져 다른 실패와 같은 방식으로
    // null 로 저하하고 로그를 남긴다 — 새 세션이 백지 재개로 가지 않도록.
    const filePath = path.join(deps.dir, `${sessionId}.md`)
    const writeFile = deps.writeFile ?? ((p: string, c: string) => fs.writeFile(p, c, 'utf8'))
    await writeAtomic(filePath, text, writeFile)
    return tabResumeLine(filePath)
  } catch (err) {
    deps.log?.(`tab resume failed session=${sessionId} form=${form}: ${String(err)}`)
    return null
  }
}
