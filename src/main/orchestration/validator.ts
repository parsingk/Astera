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
   *  없으면 평범한 Error 를 던진다. 그 이유가 Gate 의 질문이 된다 */
  start(a: { cwd: string; taskId: string }): Promise<void>
  /** 그 cwd 의 최근 출력 */
  output(cwd: string): string
}

interface Pending {
  taskId: string
  cwd: string
  /** runner.start 가 실제로 시작에 성공했는지. 자리가 사용 중이어서 아직 시작하지 못했으면
   *  false 로 남아 큐 맨 앞을 지킨다 — onRunExit 이 이 값을 보고 정산할지 재시도할지를 가른다. */
  started: boolean
}

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
    const entry: Pending = { ...a, started: false }
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
    const output = this.deps.runner.output(a.cwd)
    void this.deps
      .onSettled({ taskId: head.taskId, exitCode: a.exitCode, output })
      .catch((e) => this.deps.log?.(`validation settle failed task=${head.taskId}: ${String(e)}`))
      .finally(() => this.advance(a.cwd))
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
    try {
      await this.deps.runner.start({ cwd, taskId: head.taskId })
      head.started = true
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
    if (brokenReason !== null) {
      await this.deps
        .onCannotRun({ taskId: head.taskId, reason: brokenReason })
        .catch((err) => this.deps.log?.(`onCannotRun failed task=${head.taskId}: ${String(err)}`))
      this.advance(cwd)
    }
  }

  private advance(cwd: string): void {
    const q = this.queues.get(cwd)
    if (!q) return
    q.shift()
    if (q.length === 0) {
      this.queues.delete(cwd)
      return
    }
    void this.startHead(cwd)
  }
}
