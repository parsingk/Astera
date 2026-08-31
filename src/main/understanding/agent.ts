// 설명을 만드는 에이전트를 한 번 돌린다 — **읽기 전용으로**.
//
// 인자 벡터는 core/understanding/agentArgs.ts 가 만든다. 그 조합이 왜 그 모양인지(전부 실측이다)
// 도 거기 적혀 있고, 여기서는 프로세스와 그 주변만 다룬다 — 출력에서 값을 꺼내는 일은
// core/understanding/agentOutput.ts 가 한다.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { providerOf } from '../../core/providers/meta'
import { descriptorOf } from '../../core/providers/descriptor'
import type { Account, Provider } from '../../core/types'
import type { ProviderDescriptor } from '../../core/providers/descriptor'
import type { GeneratorSettings } from '../../core/understanding/generatorSettings'
import { extractJson, readClaudeOutput, readCodexOutput } from '../../core/understanding/agentOutput'
import { agentArgs, codexMcpServerNames } from '../../core/understanding/agentArgs'

/** 한 번의 생성에 주는 시간.
 *
 *  **실측으로 정했다.** 180초로 두었더니 이 저장소의 중간 크기 기능 하나에서 그대로 넘겼다 —
 *  17턴에 247초. 그 실패는 "만들지 못했습니다"로만 보이고, 다시 눌러도 같은 자리에서 같이
 *  끝난다. 그래서 실제로 걸리는 시간의 두 배가 조금 넘게 잡는다.
 *
 *  **그럼에도 끝은 있다.** 배경에서 도는 일이 무한히 매달리면 사용자는 그 사실조차 모른다 —
 *  이제 그 줄은 도는 동안 "만드는 중"으로 서 있으므로 기다림이 보이기는 하지만, 영원히 서
 *  있는 것과 실패는 사용자에게 같은 것이다. 읽는 양은 프롬프트가 따로 묶는다(prompt.ts 의 예산). */
const TIMEOUT_MS = 600_000

export type AgentRun = { ok: true; value: unknown } | { ok: false; reason: string }

/** win32 의 `.cmd` 셰임은 shell 없이 spawn 하면 EINVAL 이다(실측). 이 저장소가 세션을 띄울 때
 *  쓰는 방식과 같다(core/sessions/commands.ts). 인자는 전부 이 파일이 만든 것이고 사용자 입력은
 *  프롬프트 하나뿐인데, 그것은 **stdin 으로 보낸다** — cmd 의 인용 규칙을 타지 않는다. */
function wrap(file: string, args: string[]): { file: string; args: string[] } {
  return process.platform === 'win32' ? { file: 'cmd.exe', args: ['/c', file, ...args] } : { file, args }
}

interface RunArgs {
  account: Account
  descriptors: Record<Provider, ProviderDescriptor>
  generator: GeneratorSettings
  /** 에이전트의 작업 디렉터리 — 프로젝트 루트 */
  cwd: string
  prompt: string
  log?: (m: string) => void
}

/** 에이전트를 돌려 **JSON 객체 하나**를 받는다. 스키마 검증은 부르는 쪽(validate.ts)이 한다.
 *  던지지 않는다 — 생성 실패는 정상 경로이고, 사유가 화면의 `generation-failed` 에 실린다. */
export async function runAgent(a: RunArgs): Promise<AgentRun> {
  const provider = providerOf(a.account)
  const d = descriptorOf(a.descriptors, a.account)
  const codex = provider === 'codex'

  const args = agentArgs({
    provider,
    model: a.generator.model,
    effort: a.generator.effort,
    // codex 의 MCP 서버는 이름을 알아야 끌 수 있다 (agentArgs 의 주석). 읽지 못하면 빈 목록이다 —
    // **그때는 끄지 못한 채로 돈다.** 설정을 못 읽는 것은 파일이 없다는 뜻이 대부분이고(MCP 도
    // 없다), 있는데 못 읽는 드문 경우까지 생성 자체를 막을 이유는 없다.
    codexMcpServers: codex ? readCodexMcpServers(a.account.configDir) : undefined
  })

  const cmd = wrap(d.cliFile, args)
  const env = { ...process.env, [d.configDirEnv]: a.account.configDir }

  const out = await new Promise<{ stdout: string; stderr: string } | { error: string }>((resolve) => {
    // **없는 작업 디렉터리는 실행 파일 문제처럼 보인다.** win32 에서 존재하지 않는 cwd 로
    // spawn 하면 오류가 `spawn cmd.exe ENOENT` 로 오는데(실측), 그것을 그대로 사용자에게 보이면
    // "CLI 가 설치되지 않았다"로 읽힌다. 프로젝트 폴더가 사라진 것은 실제로 일어나는 일이라
    // (워크트리를 지웠거나 드라이브가 빠졌다) 여기서 갈라 준다.
    if (!existsSync(a.cwd)) {
      resolve({ error: `프로젝트 폴더가 없다: ${a.cwd}` })
      return
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd.file, cmd.args, { cwd: a.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      resolve({ error: `실행하지 못했다: ${String(e)}` })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const done = (r: { stdout: string; stderr: string } | { error: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        /* 이미 죽었다 */
      }
      resolve(r)
    }
    const timer = setTimeout(() => done({ error: `${TIMEOUT_MS / 1000}초 안에 끝나지 않았다` }), TIMEOUT_MS)

    child.stdout?.on('data', (b: Buffer) => (stdout += b.toString('utf8')))
    child.stderr?.on('data', (b: Buffer) => {
      if (stderr.length < 2000) stderr += b.toString('utf8')
    })
    child.on('error', (e) => done({ error: `실행하지 못했다: ${e.message}` }))
    child.on('close', () => done({ stdout, stderr }))

    // **프롬프트는 stdin 으로 보낸다.** 인자로 넘기면 win32 의 cmd 래퍼에서 인용이 깨지고
    // (core/sessions/commands.ts 가 같은 이유로 프롬프트를 다듬는다), 길이 제한도 탄다
    try {
      child.stdin?.write(a.prompt)
      child.stdin?.end()
    } catch (e) {
      done({ error: `프롬프트를 쓰지 못했다: ${String(e)}` })
    }
  })

  if ('error' in out) {
    a.log?.(`understanding agent failed: ${out.error}`)
    return { ok: false, reason: out.error }
  }

  const read = codex ? readCodexOutput(out.stdout) : readClaudeOutput(out.stdout)
  if (!read.ok) {
    const tail = out.stderr.trim().slice(-200)
    const reason = tail ? `${read.reason} (${tail})` : read.reason
    a.log?.(`understanding agent output unusable: ${reason}`)
    return { ok: false, reason }
  }

  const json = extractJson(read.text)
  if (!json.ok) {
    a.log?.(`understanding agent output not json: ${read.text.slice(0, 200)}`)
    return { ok: false, reason: json.reason }
  }
  return { ok: true, value: json.value }
}

/** 그 계정의 codex 설정에 잡힌 MCP 서버 이름들. 읽지 못하면 빈 목록이다 — 부르는 쪽의 주석 */
function readCodexMcpServers(configDir: string): string[] {
  try {
    return codexMcpServerNames(readFileSync(path.join(configDir, 'config.toml'), 'utf8'))
  } catch {
    return []
  }
}
