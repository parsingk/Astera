// 설명을 만드는 에이전트를 한 번 돌린다 — **읽기 전용으로**.
//
// **읽기 전용은 실측으로 정한 조합이다(2026-08-30).** 문서만 보고 정했으면 틀렸을 자리다:
//   claude — `--tools "Read,Glob,Grep"` 만으로는 **막히지 않는다.** 그 인자로 돌린 에이전트가
//            실제로 파일을 만들었다. `--permission-mode plan` 에 `--disallowedTools` 를 함께
//            줘야 막히고, 그 상태에서 읽기는 그대로 된다(둘 다 확인했다).
//   codex  — `-s read-only` 로 막힌다(확인). `--skip-git-repo-check` 는 git 저장소가 아닌
//            프로젝트에서도 돌게 한다 — 이 앱은 그런 폴더도 프로젝트로 연다.
//
// 프로세스만 여기서 다루고, 출력에서 값을 꺼내는 일은 core/understanding/agentOutput.ts 가 한다.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { providerOf } from '../../core/providers/meta'
import { descriptorOf } from '../../core/providers/descriptor'
import type { Account, Provider } from '../../core/types'
import type { ProviderDescriptor } from '../../core/providers/descriptor'
import type { GeneratorSettings } from '../../core/understanding/generatorSettings'
import { extractJson, readClaudeOutput, readCodexOutput } from '../../core/understanding/agentOutput'

/** 한 번의 생성에 주는 시간. 설명 하나는 파일 몇 개를 읽고 한 번 답하는 일이라 길 이유가 없고,
 *  **배경에서 도는 일이 무한히 매달리면 사용자는 그 사실조차 모른다.** */
const TIMEOUT_MS = 180_000

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

  const args = codex
    ? [
        'exec',
        '-s',
        'read-only',
        // git 저장소가 아닌 폴더도 이 앱은 프로젝트로 연다
        '--skip-git-repo-check',
        '--json',
        ...(a.generator.model ? ['-m', a.generator.model] : []),
        ...(a.generator.effort ? ['-c', `model_reasoning_effort="${a.generator.effort}"`] : [])
      ]
    : [
        '-p',
        // **이 둘이 함께여야 막힌다** — 위 머리주석의 실측
        '--permission-mode',
        'plan',
        '--disallowedTools',
        'Write,Edit,NotebookEdit,Bash',
        '--output-format',
        'json',
        ...(a.generator.model ? ['--model', a.generator.model] : []),
        ...(a.generator.effort ? ['--effort', a.generator.effort] : [])
      ]

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
