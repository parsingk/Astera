// 사이드바로 만든 Run 을 코디네이터 세션에 인계하는 프롬프트. 순수 함수다 — 문구가 곧 계약이고,
// 계약은 기계가 검사할 수 있어야 한다(schedule.ts 머리말과 같은 이유).

/** 코디네이터 세션의 첫 입력. **영어인 이유**: 에이전트가 읽는 문구다 — spec 파일
 *  (coordinator.ts 의 buildSpecFile)과 재개 지시문(resumeSection.ts)이 영어인 것과 같은 자리이고,
 *  화면 문구가 아니므로 i18n 을 타지 않는다.
 *
 *  **일곱 가지가 다 들어가야 한다.** 하나라도 빠지면 코디네이터가 *지킬 수 없는* 규칙이 생긴다:
 *
 *  1. 이 Run 은 사람이 짰다 — 그대로 돌려라
 *  2. **아무것도 시작하기 전에 현황을 파악하라** — 중간에 들어왔을 수 있다
 *  3. 계정은 Task 에 있다(첫 계정이 provider 다)
 *  4. 동시 실행 한도 — 숫자를 문구에 박아 넣는다
 *  5. 배치 규칙 — **이유까지** 적는다
 *  6. 네가 받은편지함이다 — 턴을 끝내면 아무것도 안 온다
 *  7. 사람이 필요하면 Gate, 그리고 그 제약
 *
 *  **2 가 필요한 이유.** 사람이 사이드바의 버튼으로 코디네이터를 **다시** 띄울 수 있다(앱은 스스로
 *  되띄우지 않는다 — Run.coordinatorSessionId 의 주석). 그때 이 세션은 처음이 아니라 **중간에**
 *  들어온다: 끝난 Task 가 있고, 앞선 코디네이터가 띄운 워커가 아직 돌고 있을 수 있고, 답을 기다리며
 *  멈춘 질문과 열린 Gate 가 쌓여 있을 수 있다. 그것을 안 보고 시작하면 이미 도는 Task 에 두 번째
 *  워커를 띄우려 하고(worker-start 가 거절한다 — 턴 낭비), 멈춰 있는 워커는 계속 멈춰 있다.
 *
 *  **처음 뜬 코디네이터에게도 같은 문구를 준다.** 갓 만든 Run 에서는 그 조사가 몇 초로 끝나고 답이
 *  비어 있다. 두 갈래 문구를 두면 어느 쪽이 최신인지 갈리고, "지금은 처음인가" 를 앱이 잘못
 *  판단하는 순간 코디네이터가 틀린 전제로 시작한다.
 *
 *  **3·4 를 문구로 주는 이유.** 값은 `run-show` 로 읽을 수 있었지만 **지키라고 말한 적이 없었고**,
 *  배치 규칙은 가이드가 이름만 부르고 정의를 어디에도 두지 않았다. 읽을 수 있는 것과 알려 준 것은
 *  다르다. 서버도 둘을 거절하지만(worker-start), 거절만 있으면 코디네이터가 시행착오로 규칙을
 *  알아내며 턴을 쓴다 — 문구가 1차이고 거절이 2차다.
 *
 *  **4 에 이유를 적는 이유.** 규칙만 아는 코디네이터는 규칙이 닿지 않는 상황에서 아무 선택이나
 *  한다. 왜 병렬 워커가 한 폴더를 공유하면 안 되는지 알면 그 바깥에서도 옳게 판단한다. */
/** 코디네이터 세션에 실제로 들어가는 **한 줄**. 위 브리핑은 파일로 가고 이것이 그 파일을 가리킨다.
 *
 *  **왜 한 줄이어야 하는가.** 이 문구는 세션의 argv 로 간다(commands.ts 의 `initialPrompt`), 그리고
 *  win32 에서 세션은 `cmd.exe /c claude …` 로 뜬다 — **줄바꿈이 명령을 끊는다.** 여러 줄 브리핑을
 *  그대로 실어 보내면 첫 줄만 남거나 아무것도 프롬프트로 들어가지 않고, 세션은 방금 열린 빈
 *  화면으로 서 있는다(실측 2026-08-28: 코디네이터가 떴지만 Task 가 돌지 않았고, 그 세션에
 *  트랜스크립트가 아예 없었다).
 *
 *  **이 저장소가 이미 두 번 쓴 해법이다.** 워커의 spec 파일 + `launchPrompt`(coordinator.ts), 탭
 *  재개 브리핑 + `tabResumeLine`(resumePacket.ts) — 둘 다 같은 제약 때문에 파일과 한 줄로 갈렸다.
 *  워커 쪽 문구와 어투를 맞춘다: 이미 그 문장을 읽는 에이전트가 같은 종류의 세션이다. */
export function coordinatorLaunchPrompt(briefPath: string): string {
  return `Read ${briefPath} and follow the instructions in it — it describes the Job you are managing`
}

export function buildHandoverPrompt(a: {
  runId: string
  objective: string
  /** 이미 풀린 값 — 부르는 쪽이 `run.concurrency ?? DEFAULT_CONCURRENCY` 를 계산해 넘긴다.
   *  여기서 기본값을 넣지 않는 이유는 JobRun 과 같다: 기본값을 두 곳에서 알면 갈라진다. */
  concurrency: number
  taskCount: number
}): string {
  const sequential = a.concurrency <= 1
  return [
    'You are the coordinator for one Job in Astera. A person laid it out in the app and pressed Run.',
    'Nothing else is driving it: the app starts no workers for this Run, and no other agent is',
    'reading its mail. Getting these Tasks done, and answering the workers you start, is your job.',
    '',
    'THE RUN',
    `- id: ${a.runId}`,
    `- objective: ${a.objective}`,
    `- tasks already defined: ${a.taskCount}`,
    `- concurrency limit: ${a.concurrency}`,
    '',
    'START HERE',
    'Run `astera help` and read the reference before your first command.',
    '',
    'TAKE STOCK BEFORE YOU START ANYTHING',
    'You may be joining this Run part-way through: a person can restart a coordinator from the Jobs',
    'list, and the one before you may have left workers running. Four questions, in this order:',
    `- \`astera task-list --run ${a.runId} --json\` — what is completed, ready, dispatched or blocked.`,
    '- For every Task that says `dispatched`: `astera dispatch-show --task <tsk> --json`. An open',
    '  dispatch means a worker outlived your predecessor and is still working — leave it alone and',
    '  wait for its report. A closed one with no outcome means that attempt died; that Task needs a',
    '  new worker (`worker-start --retry-of <dsp>`), not a duplicate.',
    '- `astera check --json` — mail already waiting. **Answer it before starting new work**: a worker',
    '  that asked a question is stopped until you reply, and no amount of new dispatching moves it.',
    '- `astera gate-list --status open --json` — what a person still owes you. Those Tasks are blocked',
    '  and will not move until the answer arrives; do not try to start them.',
    'On a Run that has only just been created all four come back nearly empty, and that is the answer.',
    '',
    'THE PLAN IS ALREADY MADE',
    'The Tasks, their dependencies, their accounts and their validation settings were set by a',
    'person. Run them as they stand. Do not create Tasks, do not rewrite their specs, and do not',
    'reassign their accounts. If the plan looks wrong to you, say so to the person through a Gate',
    'instead of editing around it.',
    '',
    'ACCOUNTS COME FROM THE TASK',
    'Each Task carries `accountIds`, in order. Start its worker on the first one.',
    'The first account decides which CLI runs the Task — pass its provider as `--agent`.',
    'The rest of the list is where a usage limit moves the worker to,',
    'so never mix providers inside one Task.',
    '',
    `CONCURRENCY IS ${a.concurrency}`,
    `Never let more than ${a.concurrency} dispatch(es) be open in this Run at once. Count the open`,
    'ones before you start another. `worker-start` rejects the call that would exceed the limit, and',
    'a rejection costs you a turn.',
    '',
    'WHERE WORKERS RUN',
    sequential
      ? '- This Run is sequential (limit 1): omit `--worktree`. Every worker runs in this Run\'s own worktree, one after another.'
      : `- This Run is parallel (limit ${a.concurrency}): pass \`--worktree new --name <short-name>\`. Each worker gets its own worktree.`,
    '- Why: merging the work back requires a clean tree, so parallel workers must not share one',
    '  folder — they would overwrite each other. `worker-start` rejects that combination.',
    '',
    'YOU ARE THE INBOX',
    '`astera check --wait --json` blocks until a worker reports, asks or escalates. Keep calling it.',
    '**If you end your turn, nothing reaches you** and this Job stops until the app nudges you,',
    'which costs a round trip. Answer a question with `astera reply --id <msg> --body -`, and decide',
    'it yourself whenever the Task spec and the objective above already answer it — that is what a',
    'coordinator is for.',
    '',
    'WHEN A PERSON IS ACTUALLY NEEDED',
    '`astera gate-create --task <tsk> --question -` opens a Gate and the person answers it in the',
    'app. A Gate cannot be created for a Task that has an open dispatch — if that worker must not',
    'carry on, stop it first with `worker-stop`.'
  ].join('\n')
}
