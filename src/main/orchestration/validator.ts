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
    const head = this.queues.get(cwd)?.[0]
    if (!head) return
    try {
      await this.deps.runner.start({ cwd, taskId: head.taskId })
      head.started = true
    } catch (e) {
      if (e instanceof ValidatorBusyError) {
        // 지나가는 문제다 — 사람에게 묻지 않는다. 헤드는 시작하지 못한 채 큐 맨 앞에 그대로
        // 남고, 자리를 비운 실행이 끝나면 onRunExit 이 다시 이곳을 부른다.
        this.deps.log?.(`validation waiting for a free slot cwd=${cwd} task=${head.taskId}: ${String(e)}`)
        return
      }
      // 시작 자체가 안 됐으므로 종료도 오지 않는다. 이 자리에서 큐를 넘기지 않으면 그 cwd 가 영원히 막힌다.
      this.deps.log?.(`validation could not start task=${head.taskId}: ${String(e)}`)
      await this.deps
        .onCannotRun({ taskId: head.taskId, reason: String(e) })
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
