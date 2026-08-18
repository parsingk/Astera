// 검증 실행의 순서 관리. RunManager 도 OrchState 도 모른다 — 러너와 두 콜백만 안다.
// 그래서 테스트가 닿는다(ipc.ts 안에 있었다면 닿지 않았을 것이다).
//
// cwd 별로 하나씩 도는 이유: RunManager 는 projectPath 를 키로 한 번에 하나만 돌리고, 이미 돌고
// 있으면 던진다. 검증은 워커가 일한 cwd 에서 돌므로 워크트리 워커들끼리는 충돌하지 않지만,
// --worktree current 워커들은 같은 cwd 를 공유한다. 그 충돌은 지나가는 것이므로 기다린다.

export interface ValidatorRunner {
  /** 실행을 시작한다. 시작할 수 없으면 throw — 그 이유가 Gate 의 질문이 된다 */
  start(a: { cwd: string; taskId: string }): Promise<void>
  /** 그 cwd 의 최근 출력 */
  output(cwd: string): string
}

interface Pending {
  taskId: string
  cwd: string
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
    const q = this.queues.get(a.cwd)
    if (q) {
      q.push(a)
      return
    }
    this.queues.set(a.cwd, [a])
    void this.startHead(a.cwd)
  }

  /** RunManager 의 onStatus 에서 흘러 들어온다. 검증이 아닌 실행의 종료도 오므로,
   *  큐에 없는 cwd 는 조용히 무시한다. */
  onRunExit(a: { cwd: string; exitCode: number }): void {
    const q = this.queues.get(a.cwd)
    const head = q?.[0]
    if (!q || !head) return
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
    } catch (e) {
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
