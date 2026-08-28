// 탭 세션(Job Dispatch 가 없는 일반 세션)용 재개 브리핑 포매터. resumeSection.ts 가 Job 워커의
// Checkpoint 를 문자열로 조립하는 것과 같은 자리이지만, 탭 세션에는 Checkpoint 도, spec 파일도,
// taskId 도 없다 — 그래서 별도 포매터다(계획 문서의 "브리핑이 실제로 어떻게 생기는가").
//
// 이 파일도 순수하다 — fs 를 만지지 않는다. 대화 파일을 읽어 여기 넣을 재료를 만드는 일은
// main/orchestration/resumePacket.ts 의 buildTabResumeText 가 한다.
import { sanitize } from './checkpoint'
import type { GitSummary } from './checkpoint'
import type { LastCommand, TranscriptMessage } from '../types'

/** formatTabResume 의 입력. 일곱 조각이 메모의 일곱 절에 대응한다 — 제목·최근 요청·코드 상태·손댄
 *  파일·마지막 명령이 이 인터페이스의 필드고, 꼬리도 그렇다. 지시문(BEFORE EDITING 등)은 입력이
 *  아니라 이 파일이 붙이는 고정 문장이다 — 탭 세션마다 달라질 것이 없기 때문이다. */
export interface TabResumeInput {
  /** 세션의 작업 폴더. git 이 없어도(저장소가 아니어도) 이것만은 항상 있다. */
  cwd: string
  /** 대화 파일의 `ai-title` 레코드. **대화 제목에 의존하지 않는다** — 그 레코드는 claude 버전에
   *  따라 이름이 다르고(§0 참조), 이 앱은 그 레코드를 남기는 플러그인이 없는 사용자에게도 나간다.
   *  없으면 이 줄만 빠지고 나머지 메모는 그대로 성립한다. */
  title: string | null
  /** 최근 사용자 요청, 시간 순(오래된 것부터). **어느 것도 "지금 하던 작업"으로 판정되지 않는다** —
   *  대화 중간에 요청이 바뀌었을 수 있고, 어느 것이 현재 작업인지 가리려면 대화를 읽고 이해해야
   *  하는데 그것은 모델 호출이라 이 기능이 피하려는 바로 그 비용이다. 그래서 판정 없이 증거만
   *  시간 순으로 싣는다. */
  requests: string[]
  /** 대화 중 손댄 파일. `file-history-snapshot` 레코드에서 뽑히거나(있으면), 없으면 git 의 변경
   *  목록으로 내려간다 — 그 선택은 buildTabResumeText 가 하고 여기서는 이미 정해진 목록만 받는다. */
  editedFiles: string[]
  /** 저장소 수준 git 요약. 워크트리가 git 저장소가 아니거나 읽기 자체가 실패하면 null. */
  git: GitSummary | null
  /** 의미 있는 user/assistant 메시지의 꼬리(parseTranscriptForResume 이 뽑는다). tool 원본 출력은
   *  이미 걸러진 채로 들어온다. */
  tail: TranscriptMessage[]
  /** 대화 중 마지막으로 완료된 Bash 호출(parseTranscriptForResume 이 뽑는다). codex 는 이 재료가
   *  없어 항상 null 이다(parseCodexForResume 의 JSDoc) — 그때는 이 절 자체가 빠진다. */
  lastCommand: LastCommand | null
}

/** 꼬리에 실을 최근 메시지 수 상한. §9.3(Packet 은 작아야 한다 — diff 본문·소스 내용을 담지 않는
 *  대신 어디를 보라고만 말한다)의 근거를 그대로 따른다: 대화 전체를 다시 싣는 것은 Smart Resume 이
 *  피하려는 바로 그 비용이므로, 최근 몇 개만 남긴다. */
const TAIL_MESSAGES_MAX = 6

/** 메시지 하나에 실을 문자 수 상한. 사용자 메시지에는 코드 블록이나 로그를 통째로 붙여넣은 경우가
 *  흔한데, 그것을 그대로 실으면 이 Packet 이 §9.3 이 금지한 "소스 내용"을 실어 나르는 통로가
 *  된다 — 그래서 메시지 개수뿐 아니라 메시지당 길이도 자른다. */
const MESSAGE_CHARS_MAX = 500

/** 'update' 한 줄에 실을 변경 파일 수 상한. resumeSection.ts 의 NOTE_FILES_MAX 와 같은 이유 — 이
 *  한 줄은 살아 있는 PTY 에 타이핑되므로(줄바꿈이 곧 Enter), 목록이 길면 한 줄이 화면을 뒤덮는다. */
const UPDATE_FILES_MAX = 20

/** 'handover' 의 파일 목록 상한. UPDATE_FILES_MAX 와 같은 값이고 같은 근거(§9.3)다 — 목록은 "어디를
 *  보라"는 손잡이지 목록 자체가 내용이 아니다.
 *
 *  **상한 없이 나갔다가 실측으로 잡혔다(2026-08-28).** 이 저장소의 실제 대화 파일 하나(29MB)의 마지막
 *  파일 이력 레코드가 추적 파일 149개를 싣고 있었고, 그 절만 렌더하면 8,620자다 — Job packet 이 메모
 *  **전체**에 두는 예산(resumeSection.ts 의 MAX_PACKET_CHARS = 6000)보다 크다. */
const HANDOVER_FILES_MAX = 20

/** 최근 요청 수 상한. 이것이 없으면 실제로 몇 개가 실리는지는 파서가 **메모리 안전**을 위해 둔 읽기
 *  상한이 남겨 준 값이 되고, 그것은 "몇 개를 보여줄까"를 판단한 값이 아니다. 다섯이면 요청이 바뀐
 *  흐름을 보여 주기에 충분하다 — 그것이 이 절의 목적이다. */
const REQUESTS_MAX = 5

/** 메모 전체의 상한. resumeSection.ts 의 MAX_PACKET_CHARS 와 같은 역할이고 같은 근거(§9.3)다. 절마다
 *  상한을 두어도 절의 수만큼 곱해지므로 마지막 방어선을 하나 둔다.
 *
 *  **Task 7 이후에도 유효한 근거.** 'handover' 의 이 문자열은 이제 프롬프트 자리에 직접 실리지
 *  않고 파일로 옮겨 간다(main/orchestration/resumePacket.ts 의 buildTabResumeText). 그래도 이
 *  상한이 재는 것은 원래 "터미널 한 줄의 길이"가 아니라 §9.3 이 금지한 것 — diff 본문·소스 내용을
 *  담지 않는 것 — 이었으므로 근거는 그대로다: 새 세션이 이 파일을 읽는 비용이 곧 그 세션의
 *  할당량에서 나가고, 그 값을 작게 유지하는 것이 이 상한의 일이다. */
const MEMO_CHARS_MAX = 6000

/** LAST COMMAND 절의 결과 발췌 상한(문자). §9.3(diff 본문·소스 내용은 담지 않고 어디를 보라고만
 *  말한다)의 근거를 그대로 따른다 — 이 발췌는 워커가 다듬어 쓴 report body(checkpoint.ts 의
 *  REPORT_BODY_MAX)와 달리 가공되지 않은 Bash stdout/stderr 원문이라서, 실패한 테스트의 로그
 *  전체를 그대로 담을 수 있다. 새 세션이 필요한 것은 "성공/실패의 증거" 한 조각이지 로그 전체가
 *  아니다. */
const LAST_COMMAND_EXCERPT_MAX = 300

/** 명령 문자열 자체의 상한. 발췌에만 상한을 두고 명령은 안 두었다가 리뷰가 잡았다 — 마지막 호출이
 *  여러 줄 heredoc(`git commit -m "$(cat <<'EOF' … EOF)"` 같은 것)이면 명령 하나가 수천 자다.
 *  전체 예산이 그 총량을 막아 주지만, 예산을 넘기면 뒤쪽 절부터 밀려 나가므로 이 절 하나가 손댄
 *  파일 목록과 대화 꼬리를 통째로 밀어낼 수 있다. 발췌보다 넉넉한 이유는 명령은 **무엇을 실행했나**
 *  라는 판단의 핵심이고 발췌는 그 결과의 증거 한 조각이기 때문이다. */
const LAST_COMMAND_CHARS_MAX = 600

/** 목록을 상한까지만 싣고 **잘린 개수를 밝힌다.** 조용히 자르면 새 세션이 "이게 전부"로 읽는다. */
function cappedList(items: string[], max: number): string {
  const shown = items.slice(0, max)
  const rest = items.length - shown.length
  const lines = shown.map((x) => `- ${x}`)
  if (rest > 0) lines.push(`- …and ${rest} more`)
  return lines.join('\n')
}

function truncateMessage(text: string): string {
  const t = text.trim()
  return t.length > MESSAGE_CHARS_MAX ? t.slice(0, MESSAGE_CHARS_MAX) + '…' : t
}

function truncateExcerpt(text: string): string {
  const t = text.trim()
  return t.length > LAST_COMMAND_EXCERPT_MAX ? t.slice(0, LAST_COMMAND_EXCERPT_MAX) + '…' : t
}

const HEADER = 'You are continuing an existing Astera session.\n\nDo not start over from scratch.'

function titleSection(input: TabResumeInput): string | null {
  if (!input.title) return null
  return `CONVERSATION TITLE\n${input.title}`
}

// 라벨을 "이것이 작업이다"가 아니라 "최근에 이렇게 요청받았다"로 둔다 — 대화 중간에 요청이 바뀐
// 세션에서 첫 메시지를 작업으로 넘기면 새 세션이 이미 끝났거나 버려진 작업을 다시 시작한다.
function requestsSection(input: TabResumeInput): string | null {
  if (!input.requests.length) return null
  // sanitize 를 truncate 보다 먼저 적용한다 — 잘라낸 뒤에 훑으면 자격 증명이 잘려 나가 게이트를
  // 통과하지 못하고 그대로 남을 수 있다(checkpoint.ts 의 looksLikeSecret 은 16자 이상의 끊기지
  // 않은 런을 요구한다).
  const recent = input.requests.slice(-REQUESTS_MAX).map((r) => truncateMessage(sanitize(r)))
  return (
    'RECENT REQUESTS (oldest first — evidence of what was asked, not a judgment about which one ' +
    `is the current task)\n${cappedList(recent, REQUESTS_MAX)}`
  )
}

function stateSection(input: TabResumeInput): string {
  const lines = [`Working directory: ${input.cwd}`]
  if (input.git) {
    if (input.git.branch) lines.push(`Branch: ${input.git.branch}`)
    if (input.git.head) lines.push(`HEAD: ${input.git.head}`)
    if (input.git.diffstat) lines.push(`Diffstat: ${input.git.diffstat}`)
  } else {
    // git 이 없으면 이 절이 조용히 얇아지는 대신 **왜** 얇은지를 밝힌다 — 그렇지 않으면 새 세션은
    // "코드 상태에 대해 확인된 것이 없다"를 "변경 사항이 없다"로 잘못 읽을 수 있다.
    lines.push(
      'No git evidence for this directory (not a repository, or git could not be read) — ' +
        'inspect the files directly.'
    )
  }
  return `CURRENT STATE\n${lines.map((l) => `- ${l}`).join('\n')}`
}

function filesSection(input: TabResumeInput): string | null {
  if (!input.editedFiles.length) return null
  return `FILES TOUCHED IN THIS CONVERSATION\n${cappedList(input.editedFiles, HANDOVER_FILES_MAX)}`
}

function tailSection(input: TabResumeInput): string | null {
  if (!input.tail.length) return null
  const shown = input.tail.slice(-TAIL_MESSAGES_MAX)
  const lines = shown.map((m) => `[${m.role}] ${truncateMessage(sanitize(m.text))}`)
  return `CONVERSATION TAIL (most recent last)\n${lines.join('\n')}`
}

// 명령 자체는 가리지 않는다 — 담을 대상은 결과 발췌뿐이다(위 sanitize 재사용 JSDoc, checkpoint.ts).
// 명령 문자열은 에이전트가 무엇을 실행하기로 **선택**한 값이지 자유 서술이 아니고, slack/transcript.ts
// 의 REDACTED_KEYS 도 같은 이유로 Bash 의 command 는 가리지 않는다(그 파일의 주석 — 무엇을 실행하는지
// 자체가 판단의 핵심이라 가리면 판단이 불가능해진다). 종료 코드는 트랜스크립트에 없으므로(있는 것은
// tool_result.is_error 불리언뿐) "실패/성공"이라고만 적는다 — 없는 정밀도를 지어내지 않는다.
function lastCommandSection(input: TabResumeInput): string | null {
  const lc = input.lastCommand
  if (!lc) return null
  const command =
    lc.command.length > LAST_COMMAND_CHARS_MAX
      ? lc.command.slice(0, LAST_COMMAND_CHARS_MAX) + '…'
      : lc.command
  const lines = [command, lc.failed ? 'Result: failed.' : 'Result: succeeded.']
  const excerpt = truncateExcerpt(sanitize(lc.excerpt))
  if (excerpt) lines.push(excerpt)
  return `LAST COMMAND\n${lines.join('\n')}`
}

// Job 쪽 BEFORE_EDITING(resumeSection.ts)과 같은 목적이되, 보고 의무 줄은 없다 — 탭 세션에는
// worker_done 을 받을 Task 가 없고, 그 문장을 넣으면 없는 프로토콜을 따르라고 지시하는 셈이 된다.
const BEFORE_EDITING = `BEFORE EDITING
1. Inspect git status.
2. Inspect the current git diff before editing.
3. Read the changed files.
4. Continue from the current implementation.

Preserve the existing worktree and unfinished changes.`

/** 증거 절들을 예산 안으로 조립하고, **지시문은 언제나 뒤에 붙인다.**
 *
 *  **지시문이 잘림의 대상이 아닌 이유.** 예산을 넘으면 뒤에서 자르는데(앞쪽 절이 더 중요하므로),
 *  가장 뒤에 있는 것이 지시문 블록이다. 그러면 예산을 넘긴 메모에서 하필 "처음부터 다시 하지
 *  말고 현재 상태를 직접 확인하라"가 사라진다 — 이 기능이 존재하는 이유가 그 문장이다. 증거는
 *  많고 적음의 문제지만 지시문은 있고 없음의 문제라서, 잘림은 증거에만 적용한다.
 *
 *  잘랐다는 사실을 밝히는 이유는 cappedList 와 같다: 조용히 자르면 새 세션이 "이게 전부"로 읽는다. */
function assemble(evidence: Array<string | null>, instructions: string): string {
  const joined = evidence.filter((s): s is string => s !== null && s.length > 0).join('\n\n')
  const tailPart = `\n\n${instructions}`
  const budget = MEMO_CHARS_MAX - tailPart.length
  if (joined.length <= budget) return joined + tailPart
  const note = '\n\n[This briefing was truncated to fit its size budget.]'
  return joined.slice(0, budget - note.length) + note + tailPart
}

/** 새 프로세스로 이어받을 전체 메모. `--resume`을 부르는 재개(프로세스가 새것이라 대화를 통째로
 *  잃는다) 자리에 쓴다 — resumeSection.ts 의 formatResumeSection 과 같은 자리다.
 *
 *  **대화 증거(꼬리·요청·마지막 명령) 중 하나도 없으면 null — git 만으로는 이 계약을 채우지
 *  못한다.** git 은 "지금 코드가 어떤 상태인가"의 증거일 뿐 "이 대화에서 무엇을 하고 있었는가"의
 *  증거가 아니다. 대화 파일을 못 읽었을 때(transcriptPath 를 모르거나 provider 를 잘못 짚었을
 *  때) tail·requests·lastCommand 는 셋 다 비어서 돌아오고 git 만 채워지는데, 그때 git 만으로
 *  메모를 냈다가 실측으로 잡혔다(2026-08-28) — `briefed` 가 참이 되어 buildTabResumeText 가 이
 *  메모를 파일에 쓰고 재개는 대화를 통째로 버린 채(계획이 금지하는 자리에서) 백지나 다름없는
 *  handover 를 골랐다. title·editedFiles 도 이 계약을 채우지 못한다 — title 은 대화의 흔적일
 *  뿐 확인이 아니고, editedFiles 는 대화 기록이 없으면 git 변경 목록으로 그대로 채워지므로
 *  (buildTabResumeText) "대화를 읽었다"는 증거가 되지 못한다. */
function formatHandover(input: TabResumeInput): string | null {
  if (input.tail.length === 0 && input.requests.length === 0 && input.lastCommand === null) return null
  return assemble(
    [
      HEADER,
      titleSection(input),
      requestsSection(input),
      stateSection(input),
      lastCommandSection(input),
      filesSection(input),
      tailSection(input)
    ],
    BEFORE_EDITING
  )
}

/** 살아 있는 세션에 덧붙이는 한 줄. **꼬리를 싣지 않는다** — 그 세션은 대화를 그대로 갖고 있으므로
 *  다시 실으면 §11.5 가 막으려던 낭비(방금 리셋된 할당량을 이미 아는 것을 재구성하는 데 쓴다)를
 *  그대로 한다. 기다리는 동안 무엇이 바뀌었는지, 즉 현재 git 상태만 싣는다 —
 *  resumeSection.ts 의 formatResumeNote 와 같은 계약: git 을 못 읽었으면(`git === null`) null. */
function formatUpdate(input: TabResumeInput): string | null {
  if (!input.git) return null
  const parts: string[] = []
  const changed = input.git.changed
  if (changed.length === 0) parts.push('There are no uncommitted changes right now.')
  else {
    const shown = changed.slice(0, UPDATE_FILES_MAX)
    const more = changed.length - shown.length
    parts.push(`Uncommitted changes right now: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`)
  }
  parts.push('Check the current git diff before editing.')
  return parts.join(' ')
}

/**
 * TabResumeInput -> 재개 프롬프트 문자열. **두 모양을 낸다** — 워커 쪽이 buildResumePacket(전체
 * 인계)/buildResumeNote(한 줄)로 나누는 것과 같은 구분이고, 기준도 같다(SPEC §11.5): `--resume`을
 * 부르는 재개는 프로세스가 새것이라 전체 인계가 값을 내고('handover'), 부르지 않는 재개는 같은
 * 프로세스가 계속 돌아 떨어뜨린 것이 없으니 덧붙일 한 줄이면 된다('update').
 *
 * 같은 Input 은 항상 같은 문자열을 낸다 — 시계를 읽지 않는다.
 */
export function formatTabResume(input: TabResumeInput, form: 'handover' | 'update'): string | null {
  return form === 'update' ? formatUpdate(input) : formatHandover(input)
}
