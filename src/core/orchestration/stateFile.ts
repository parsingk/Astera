// Host 가 없을 때, 아무도 쓰지 않는 파일로 읽기 명령에 답한다 (host control plane design §8).
//
// **여기가 core 인 이유는 store.ts 가 core 인 이유와 같다.** 이 파일을 읽는 것은 Host 와 CLI 둘이고,
// 둘 중 어느 쪽도 Electron 이 아니다. `node:fs` 와 순수 층만 쓴다.
import { readFileSync } from 'node:fs'
import { handleCommand, type OrchServerDeps } from './command'
import { isValidState, migrateLoadedState } from './store'
import type { OrchState } from './state'

/**
 * Host 없이 파일로 답할 수 있는 명령들.
 *
 * **cliPublic.ts 가 목록을 두는 것과 같은 이유로 허용 목록이다**: 나중에 붙는 명령은 누군가 생각해
 * 보기 전까지 파일로 답할 수 있는 명령이 아니고, 기본을 "된다" 로 두면 새로 생긴 **기다리는** 명령이
 * "Host 가 없다" 대신 낡은 답을 조용히 내놓는다.
 *
 * `run-configs` 가 여기 있는 것은 그것이 상태를 읽어 답하는 명령이기 때문이다 — 다만 검사 구성 목록
 * 자체는 앱의 것이라(`OrchServerDeps.listRunConfigs`) 이 길에서는 그 명령 자신의 문서화된 부재값인
 * 빈 목록으로 답한다. 그 값을 읽고 `--validate` 를 빼는 코디네이터는 Host 가 없으면 애초에 돌고
 * 있지 않다. **Host 가 떠 있을 때는 정반대다** — 그쪽에서는 이 명령이 거절로 간다(`host/orchDeps.ts`
 * 의 PROPAGATES). 거기서는 속을 코디네이터가 살아 있기 때문이고, 그 파일이 이 길을 자기 유일한
 * 예외로 적어 두고 있다.
 */
const FROM_FILE = new Set([
  'jobs-list', 'jobs-get', 'runs-list', 'runs-get', 'tasks-list',
  'questions-list', 'questions-get', 'projects-list', 'projects-get', 'projects-find',
  'status', 'dispatch-show', 'inbox', 'run-configs'
])

export const fileAnswerable = (cmd: string): boolean => FROM_FILE.has(cmd)

/**
 * 상태 파일을 읽는다 — 없거나 읽을 수 없으면 `null`.
 *
 * **`null` 은 빈 상태가 아니다.** 부르는 쪽은 이것을 종료 코드 3 으로 바꾼다(run.ts): 파일을 못 읽은
 * 것을 빈 Job 목록으로 내면 사람은 자기 Job 이 사라졌다고 읽는다.
 *
 * **맨 `JSON.parse` 가 아니다** — `store.load()` 가 태우는 이행을 그대로 태운다(migrateLoadedState).
 * 옛 앱이 쓴 파일이 CLI 에서와 Host 에서 다르게 읽히면 안 된다.
 *
 * 동기 읽기다. 이 CLI 프로세스는 명령 하나를 답하고 끝나므로 막을 이벤트 루프가 없고, run.ts 의
 * 다른 파일 읽기도 전부 동기다.
 */
export function readStateFile(filePath: string): OrchState | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
  // 손상된 파일을 `.bak` 로 옮기는 것은 이 쪽의 일이 아니다 — 그것은 파일의 주인인 Host 가 할 일이고
  // (store.load 의 복구), 읽기만 하러 온 CLI 가 남의 파일을 옮기면 Host 가 다음에 여는 파일이 사라진다.
  if (!isValidState(parsed)) return null
  return migrateLoadedState(parsed)
}

/** 이 길에서는 부를 수 없는 칸. `fileAnswerable` 이 고른 명령은 전부 읽기이므로 아무도 여기 닿지
 *  않는다 — 닿는다면 허용 목록에 쓰는 명령이 섞인 것이고, 그때는 조용히 옛 상태를 답하는 것보다
 *  그 자리에서 터지는 편이 낫다. */
const needsHost = (name: string) => (): never => {
  throw new Error(`${name} needs the Host — this answer was read from the state file`)
}

/**
 * 읽기 명령 하나를 파일에서 읽은 상태로 답한다.
 *
 * **`handleCommand` 를 그대로 쓴다.** 목록과 상세가 어떤 모양인지는 그 층이 알고 있고(jobView·
 * runView·outcomeOf), 여기서 다시 적으면 Host 가 답할 때와 파일로 답할 때가 갈린다.
 */
export async function answerFromFile(a: {
  state: OrchState
  cmd: string
  args: Record<string, unknown>
  sessionId: string
}): Promise<{ status: number; body: unknown }> {
  const deps = {
    getState: () => a.state,
    setState: needsHost('setState'),
    startWorker: needsHost('startWorker'),
    releaseWorker: needsHost('releaseWorker'),
    listAccounts: needsHost('listAccounts'),
    readWorker: needsHost('readWorker')
  } as unknown as OrchServerDeps
  const r = await handleCommand(deps, { sessionId: a.sessionId }, a.cmd, a.args)
  // **`status` 만 고쳐 내보낸다.** 그 명령의 `running: true` 와 `pid` 는 "이 명령에 닿았다는 것이
  // 곧 앱이 있다는 답이다" 라는 전제로 적힌 값인데(command.ts 의 status), 이 길에서는 그 전제가
  // 거짓이다 — Host 는 없고 `process.pid` 는 CLI 자신의 것이다. 두 칸을 그대로 내보내면 사람은
  // 돌고 있지 않은 Host 가 돌고 있다고 읽는다. 나머지 숫자는 파일에서 센 것이라 그대로 맞다.
  if (a.cmd === 'status' && r.status === 200 && r.body !== null && typeof r.body === 'object')
    return { status: r.status, body: { ...r.body, running: false, pid: null } }
  return r
}
