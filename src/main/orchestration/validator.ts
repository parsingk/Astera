// 검증 실행의 순서 관리. RunManager 도 OrchState 도 모른다 — 러너와 두 콜백만 안다.
// 그래서 테스트가 닿는다(ipc.ts 안에 있었다면 닿지 않았을 것이다).
//
// cwd 별로 하나씩 도는 이유: RunManager 는 projectPath 를 키로 한 번에 하나만 돌리고, 이미 돌고
// 있으면 던진다. 검증은 워커가 일한 cwd 에서 돌므로 워크트리 워커들끼리는 충돌하지 않지만,
// --worktree current 워커들은 같은 cwd 를 공유한다. 그 충돌은 지나가는 것이므로 기다린다.

/** 그 cwd 에 자리가 없어 시작할 수 없다 — 지나가는 문제다(사용자가 손으로 Run 을 눌렀거나, 다른
 *  워크트리 워커가 먼저 돌고 있다). RunManager 는 프로젝트 경로 하나에 하나만 돌리므로, 검증 요청이
 *  왔을 때 이미 뭔가 돌고 있으면 이 에러가 된다. 사람에게 물을 이유가 없는 유일한 실패 종류라서
 *  다른 Error 와 구분해서 온다 — startHead 는 이 에러를 onCannotRun 으로 넘기지 않고, 헤드를 큐에
 *  그대로 둔 채 그 실행이 끝나기를 기다린다(onRunExit). */
export class ValidatorBusyError extends Error {
  constructor(cwd: string) {
    super(`ALREADY_RUNNING: ${cwd}`)
    this.name = 'ValidatorBusyError'
  }
}

export interface ValidatorRunner {
  /** 실행을 시작한다. 자리가 사용 중이면 ValidatorBusyError 를 던진다 — 그 밖의 이유로 시작할 수
   *  없으면 평범한 Error 를 던진다. 그 이유가 Gate 의 질문이 된다.
   *
   *  **'skip' 은 실패가 아니다.** 그 항목이 더 이상 할 일이 아니라는 뜻이다 — 큐에서 기다리는 동안
   *  Task 가 validating 을 떠났고(task-update 로 사람이 손수 구해 냈다), 그 검증의 결과를 받을 자리가
   *  이미 없다. 던져서 Gate 를 열면 사람의 결정을 되돌리게 되므로(ready/failed -> blocked 는 전이표가
   *  허용한다) 조용히 큐에서 빠지는 길이 따로 있어야 한다. 판정을 여기 인터페이스에 두는 이유는
   *  runner 구현이 ipc.ts 의 클로저이고 테스트가 거기까지 닿지 않기 때문이다 — 그 클로저는 사실만
   *  돌려주고, 그것으로 무엇을 할지는 이 클래스가 정한다.
   *
   *  아무것도 돌려주지 않으면 시작한 것이다. */
  start(a: { cwd: string; taskId: string }): Promise<'skip' | void>
  /** 그 cwd 의 최근 출력 */
  output(cwd: string): string
}

interface Pending {
  taskId: string
  cwd: string
  /** runner.start 가 실제로 시작에 성공했는지. 자리가 사용 중이어서 아직 시작하지 못했으면
   *  false 로 남아 큐 맨 앞을 지킨다 — onRunExit 이 이 값을 보고 정산할지 재시도할지를 가른다. */
  started: boolean
  /** 이 항목의 종료를 이미 정산 중인가. 같은 head 의 종료가 겹쳐 들어오면 정산도 advance 도 두 번
   *  일어난다 — 두 번째 정산은 applyValidationResult 가 거절하므로 상태는 안전하지만, runner.output
   *  을 헛되게 부르고 거절 로그를 남긴다. 유실을 막는 것은 advance 의 항등성 검사고, 이 표시는 그
   *  헛일 자체를 막는다. */
  settling: boolean
  /** 사용자가 이 검증 실행을 정지시켰다(markStopped). 이어질 종료는 결과가 아니라 "증명하지
   *  못했다"이므로 onSettled 가 아니라 onCannotRun 으로 간다. */
  stopped: boolean
}

/** 정지된 검증이 Gate 에 남기는 이유. blockForValidation 이 앞에 한국어 문장을 붙인다 */
const STOPPED_REASON = '사용자가 검증 실행을 정지했습니다'

export class TaskValidator {
  /** cwd -> 대기열. 맨 앞이 지금 도는 것이다 */
  private queues = new Map<string, Pending[]>()
  /** 지금 startHead 가 진행 중인 cwd 의 집합. onRunExit 의 재시도 호출이 재진입하는 것을 막는다 —
   *  이 표시가 없으면, 헤드가 아직 시작하지 못한 채 겹쳐 들어온 두 번째 종료가 startHead 를 또
   *  부르고, 그 두 번째 시도가 첫 번째와 겹쳐 사용자 명령을 두 번 시작하게 된다. */
  private starting = new Set<string>()

  constructor(
    private deps: {
      runner: ValidatorRunner
      onSettled: (a: { taskId: string; exitCode: number; output: string }) => Promise<void>
      onCannotRun: (a: { taskId: string; reason: string }) => Promise<void>
      log?: (message: string) => void
    }
  ) {}

  enqueue(a: { taskId: string; cwd: string }): void {
    const entry: Pending = { ...a, started: false, settling: false, stopped: false }
    const q = this.queues.get(a.cwd)
    if (q) {
      q.push(entry)
      return
    }
    this.queues.set(a.cwd, [entry])
    void this.startHead(a.cwd)
  }

  /** RunManager 의 onStatus 에서 흘러 들어온다. 검증이 아닌 실행의 종료도 오므로,
   *  큐에 없는 cwd 는 조용히 무시한다. */
  onRunExit(a: { cwd: string; exitCode: number }): void {
    const q = this.queues.get(a.cwd)
    const head = q?.[0]
    if (!q || !head) return
    // 헤드가 아직 시작하지 못했다면 이 종료는 헤드의 것이 아니다 — 그 자리를 차지하고 있던 다른
    // 실행(사용자가 손으로 누른 Run, 혹은 --worktree current 를 공유하는 다른 워커)이 끝나
    // 자리가 빈 것뿐이다. 그 종료 코드로 정산하면 엉뚱한 실행의 결과를 Task 에 확정짓게 되므로,
    // 정산 대신 헤드의 시작을 다시 시도한다. 타이머는 필요 없다 — 이 종료 이벤트가 신호다.
    if (!head.started) {
      void this.startHead(a.cwd)
      return
    }
    // 같은 head 의 종료가 두 번 들어오는 창이 있다 — 정산은 await 이고, 그 사이에 도착한 두 번째
    // 종료는 head 가 아직 큐 맨 앞이고 started 라서 여기까지 온다. 한 번만 정산한다.
    if (head.settling) return
    head.settling = true
    // 사용자가 정지시킨 검증의 종료 코드는 0 이 아니지만, 그것은 "작업이 틀렸다"가 아니라
    // "증명하지 못했다"다. 실패로 세면 남의 빌드를 치우려던 사용자가 Task 를 실패시키고 세 번이면
    // 회로가 끊긴다 — 그래서 Gate 로 보낸다(markStopped 참고).
    if (head.stopped) {
      head.stopped = false // 표시는 소비하고 지운다
      void this.deps
        .onCannotRun({ taskId: head.taskId, reason: STOPPED_REASON })
        .catch((e) => this.deps.log?.(`onCannotRun failed task=${head.taskId}: ${String(e)}`))
        .finally(() => this.advance(a.cwd, head))
      return
    }
    const output = this.deps.runner.output(a.cwd)
    void this.deps
      .onSettled({ taskId: head.taskId, exitCode: a.exitCode, output })
      .catch((e) => this.deps.log?.(`validation settle failed task=${head.taskId}: ${String(e)}`))
      .finally(() => this.advance(a.cwd, head))
  }

  /** 사용자가 그 cwd 에서 도는 검증 실행을 정지시켰다(run.stop). 여기서는 표시만 남기고, 판정은
   *  곧 도착할 onRunExit 이 한다 — 정지는 종료 코드로만 구별할 수 없기 때문이다.
   *  시작하지 못한 head 에는 표시하지 않는다: 그 cwd 에서 도는 것은 검증이 아니라 그 자리를
   *  차지하고 있는 다른 실행이므로, 그 정지는 이 검증과 아무 상관이 없다. */
  markStopped(cwd: string): void {
    const head = this.queues.get(cwd)?.[0]
    if (!head?.started) return
    head.stopped = true
  }

  private async startHead(cwd: string): Promise<void> {
    // 재진입 방지. onRunExit 은 헤드가 시작하지 못한 채로 겹쳐 들어오면 이 함수를 다시 부른다
    // (아래 onRunExit 참고) — 그 두 번째 호출이 여기를 그냥 지나가면 runner.start 가 같은 헤드에
    // 대해 두 번 불려 사용자 명령이 두 번 시작된다. finally 에서 지우기 전까지는 무조건 되돌아간다.
    if (this.starting.has(cwd)) return
    const head = this.queues.get(cwd)?.[0]
    if (!head) return
    this.starting.add(cwd)
    // 시작하지 못한 이유를 밖으로 들고 나온다 — advance 호출은 이 블록 다음, starting 을 지운
    // 뒤에 있어야 한다. advance 가 부르는 다음 startHead 는 같은 cwd 를 다시 검사하므로, 그때도
    // starting 이 남아 있으면 방금 추가한 지금 이 표시에 막혀 아무 일도 하지 않게 된다.
    let brokenReason: string | null = null
    // 이 항목이 더 이상 할 일이 아닌가. brokenReason 과 같은 이유로 밖으로 들고 나온다.
    let skipped = false
    try {
      const outcome = await this.deps.runner.start({ cwd, taskId: head.taskId })
      if (outcome === 'skip') skipped = true
      else head.started = true
    } catch (e) {
      // ValidatorBusyError 가 표준 경로지만, RunManager 가 곧바로 던지는 그대로도 온다 — ipc.ts 의
      // 사전 검사는 시작 전에 살펴보는 지름길일 뿐, RunManager 의 실제 판정과 이중화돼 있지 않다.
      // 그 둘이 어긋나는 날(RunManager 가 상태를 하나 더 갖게 되거나 거절 이유가 하나 늘면)에도
      // 지나가는 문제와 진짜 실패의 구분은 여기, 테스트가 닿는 자리에 있어야 한다.
      const busy =
        e instanceof ValidatorBusyError || (e instanceof Error && e.message.startsWith('ALREADY_RUNNING:'))
      if (busy) {
        // 지나가는 문제다 — 사람에게 묻지 않는다. 헤드는 시작하지 못한 채 큐 맨 앞에 그대로
        // 남고, 자리를 비운 실행이 끝나면 onRunExit 이 다시 이곳을 부른다.
        this.deps.log?.(`validation waiting for a free slot cwd=${cwd} task=${head.taskId}: ${String(e)}`)
      } else {
        // 시작 자체가 안 됐으므로 종료도 오지 않는다. 이 자리에서 큐를 넘기지 않으면 그 cwd 가 영원히 막힌다.
        this.deps.log?.(`validation could not start task=${head.taskId}: ${String(e)}`)
        brokenReason = String(e)
      }
    } finally {
      this.starting.delete(cwd)
    }
    // 할 일이 아닌 항목은 조용히 빠진다 — onCannotRun 도, 실패 기록도 없다. 큐는 계속 움직여야
    // 하므로 advance 는 부른다(항등성 검사가 그대로 이 항목을 지운다). 낡은 검증이 사람의 구조를
    // 되돌리는 것을 막는 것이 요점이고, 검사 자체의 목적 — 이미 지나간 Task 를 위해 빌드가 몇 분
    // 돌면서 실행 패널을 덮는 것을 막는 것 — 은 그대로 남는다.
    if (skipped) {
      this.deps.log?.(`validation no longer needed task=${head.taskId} cwd=${cwd}`)
      this.advance(cwd, head)
      return
    }
    if (brokenReason !== null) {
      await this.deps
        .onCannotRun({ taskId: head.taskId, reason: brokenReason })
        .catch((err) => this.deps.log?.(`onCannotRun failed task=${head.taskId}: ${String(err)}`))
      this.advance(cwd, head)
    }
  }

  /** 큐 맨 앞을 지나 다음 항목으로 넘어간다.
   *
   *  **entry 를 받는 이유는 항등성 검사다.** 같은 head 에 대해 이 함수가 두 번 불릴 수 있는 창이
   *  두 군데 있다 — 겹쳐 들어온 종료(위 settling 표시가 막는 그것), 그리고 고장난 head 의 이중
   *  시작(startHead 에서 starting 은 finally 로 풀리는데 advance 는 await onCannotRun 뒤에 온다.
   *  그 창에 도착한 종료가 head.started === false 를 보고 startHead 를 다시 부르면 같은 고장난
   *  head 로 runner.start 가 또 불리고, 두 번째 onCannotRun 과 두 번째 advance 가 이어진다).
   *  무조건 shift 하면 그 두 번째 호출이 아직 시작하지 않은 다음 항목을 큐에서 지운다. 그 Task
   *  에는 종료가 오지 않으므로 영원히 validating 이고, recomputeReady 는 completed 만 승격시키므로
   *  그 의존 서브트리 전체가 pending 에 멈춘다 — 앱을 다시 켜는 것 말고는 회복 수단이 없다.
   *  즉 이 브랜치가 막으려는 바로 그 실패다. */
  private advance(cwd: string, entry: Pending): void {
    const q = this.queues.get(cwd)
    if (!q || q[0] !== entry) return
    q.shift()
    if (q.length === 0) {
      this.queues.delete(cwd)
      return
    }
    void this.startHead(cwd)
  }
}
