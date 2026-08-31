// 두 CLI 에게 "이 계정이 쓸 수 있는 모델이 뭐냐"고 묻는다.
//
// **한 줄짜리 stdio JSON 왕복이다 — TUI 를 파싱하지 않는다.** claude 는 stream-json 모드에서
// `control_request/initialize` 의 응답에 모델을 싣고(실측 2026-08-30, 1.9초/5개), codex 는
// `app-server` 에 `model/list` 를 받는다(실측 6개). 두 응답의 모양을 값으로 바꾸는 일은
// core/models/parse.ts 가 하고, 여기는 프로세스와 시간만 다룬다.
//
// **던지지 않는다.** 조회 실패는 정상 경로다 — claude 가 로그아웃 상태일 수도, codex 의
// app-server 가 (experimental 이라) 프로토콜을 바꿨을 수도 있다. 그때 설정 화면은 드롭다운
// 대신 자유 입력칸을 보여 주면서 사유를 말한다. 던지면 그 사유가 사라진다.
import { spawn } from 'node:child_process'
import type { ModelListResult } from '../../core/models/types'
import { parseClaudeModels, parseCodexModels } from '../../core/models/parse'

/** 이 왕복은 사용자가 설정 화면에서 기다리는 시간이다. 실측이 2초 안쪽이라 넉넉히 잡되,
 *  응답이 없는 CLI 에 무한히 매달리지 않는다. */
const TIMEOUT_MS = 20_000

/** win32 에서 `claude`/`codex` 는 `.cmd` 셰임일 수 있고, shell 없이 그것을 spawn 하면 EINVAL 이다
 *  (실측). 이 저장소는 세션을 띄울 때 이미 같은 문제를 `cmd.exe /c <cli>` 로 풀고 있다
 *  (core/sessions/commands.ts) — 같은 방식을 쓴다.
 *
 *  **여기서는 그 파일이 기록한 인용 위험이 없다.** 그쪽이 조심하는 것은 사용자가 친 프롬프트를
 *  cmd 에 넘기는 경우인데, 이 함수가 넘기는 인자는 전부 이 파일 안의 상수다. 사용자 입력은
 *  stdin 의 JSON 으로만 들어가고 그것은 cmd 가 보지 않는다. */
function wrapForPlatform(file: string, args: string[]): { file: string; args: string[] } {
  return process.platform === 'win32' ? { file: 'cmd.exe', args: ['/c', file, ...args] } : { file, args }
}

interface RunOpts {
  file: string
  args: string[]
  /** 그 계정의 격리 환경 (CLAUDE_CONFIG_DIR / CODEX_HOME) */
  env: NodeJS.ProcessEnv
  /** 프로세스가 뜨자마자 stdin 에 쓸 줄 */
  send: string
  /** 줄 하나를 보고 "이게 내가 기다리던 답인가" — 맞으면 그 값을, 아니면 null */
  match: (line: Record<string, unknown>) => unknown | null
}

/** 줄 단위 JSON 을 주고받아 첫 번째로 맞는 답을 돌려준다. 실패는 문자열 사유다 */
function roundTrip(o: RunOpts): Promise<{ value: unknown } | { error: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      // shell: true 를 쓰지 않는다 — 이 저장소의 git 어댑터와 같은 이유다. win32 의 .cmd 셰임은
      // shell 대신 cmd.exe 래퍼로 푼다 (wrapForPlatform 의 주석).
      const cmd = wrapForPlatform(o.file, o.args)
      child = spawn(cmd.file, cmd.args, { env: o.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      resolve({ error: `실행하지 못했다: ${String(e)}` })
      return
    }

    let buf = ''
    let stderr = ''
    let settled = false
    const done = (r: { value: unknown } | { error: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.stdin?.end()
        child.kill()
      } catch {
        /* 이미 죽었다 */
      }
      resolve(r)
    }
    const timer = setTimeout(() => done({ error: `${TIMEOUT_MS / 1000}초 안에 답하지 않았다` }), TIMEOUT_MS)

    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line === '') continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          continue // 이 CLI 들은 JSON 아닌 줄도 섞어 낸다 — 우리 답이 아니면 넘긴다
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
        const hit = o.match(parsed as Record<string, unknown>)
        if (hit !== null) {
          done({ value: hit })
          return
        }
      }
    })
    child.stderr?.on('data', (d: Buffer) => {
      // 사유에 실을 만큼만 — 전체를 들고 있을 이유가 없다
      if (stderr.length < 400) stderr += d.toString('utf8')
    })
    child.on('error', (e) => done({ error: `실행하지 못했다: ${e.message}` }))
    child.on('exit', (code) =>
      done({ error: `답하기 전에 종료했다 (code ${code})${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ''}` })
    )

    try {
      child.stdin?.write(o.send)
    } catch (e) {
      done({ error: `요청을 쓰지 못했다: ${String(e)}` })
    }
  })
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** claude 의 모델 목록. `cliFile` 은 프로바이더 서술자의 실행 파일(win32 는 cmd 셰임일 수 있다) */
export async function listClaudeModels(cliFile: string, configDir: string): Promise<ModelListResult> {
  const requestId = 'astera-models'
  const r = await roundTrip({
    file: cliFile,
    args: ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json'],
    // **process.env 를 펼친 위에 덮는다** — 통째로 대체하면 PATH 도 HOME 도 없는 채로 뜬다
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    send: JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } }) + '\n',
    match: (line) => {
      if (line.type !== 'control_response' || !isObj(line.response)) return null
      const res = line.response
      if (res.request_id !== requestId) return null
      // subtype 이 success 가 아니면 그것도 우리 답이다 — 오류로 끝낸다
      if (res.subtype !== 'success') return { failed: res }
      return isObj(res.response) ? res.response.models ?? [] : []
    }
  })
  if ('error' in r) return { models: [], error: r.error }
  if (isObj(r.value) && 'failed' in r.value) return { models: [], error: 'claude 가 요청을 거절했다 — 로그인 상태를 확인해 주세요' }
  const models = parseClaudeModels(r.value)
  return models.length > 0 ? { models } : { models: [], error: '모델 목록이 비어 있다' }
}

/** codex 의 모델 목록 (`app-server` 의 `model/list`). app-server 는 experimental 이라 실패가 정상 경로다 */
export async function listCodexModels(cliFile: string, codexHome: string): Promise<ModelListResult> {
  const r = await roundTrip({
    file: cliFile,
    args: ['app-server'],
    env: { ...process.env, CODEX_HOME: codexHome },
    // initialize 와 model/list 를 함께 보낸다 — app-server 는 줄 단위로 읽으므로 순서가 지켜지고,
    // 왕복을 한 번 줄인다. initialize 응답(id 1)은 match 가 그냥 넘긴다
    send:
      JSON.stringify({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'astera', title: 'Astera', version: '1.0.0' } }
      }) +
      '\n' +
      JSON.stringify({ id: 2, method: 'model/list', params: { includeHidden: false } }) +
      '\n',
    match: (line) => {
      if (line.id !== 2) return null
      if (isObj(line.error)) return { failed: line.error }
      return isObj(line.result) ? line.result.data ?? [] : []
    }
  })
  if ('error' in r) return { models: [], error: r.error }
  if (isObj(r.value) && 'failed' in r.value) return { models: [], error: 'codex 가 model/list 를 거절했다' }
  const models = parseCodexModels(r.value)
  return models.length > 0 ? { models } : { models: [], error: '모델 목록이 비어 있다' }
}
