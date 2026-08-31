// 설명 생성 에이전트에게 주는 인자 — **읽기 전용을 강제하는 자리**.
//
// 여기가 순수 함수인 이유는 하나다: 이 벡터가 틀리면 남의 저장소에 파일이 써진다. 프로세스를
// 띄우지 않고도 그 조합을 테스트로 못박을 수 있어야 한다. 실행은 main/understanding/agent.ts 다.
//
// **전부 실측으로 정했다 (2026-08-30).** 문서만 보고 정했으면 두 번 틀렸을 자리다.
import type { Provider } from '../types'

/** claude 에게 남기는 도구. 셸이 없으면 우회로도 없다 — 실측에서 이 목록이면 에이전트가
 *  "쓸 수 있는 도구가 없다"고 답한다 */
export const CLAUDE_TOOLS = 'Read,Glob,Grep'

/** 그럼에도 이름으로 한 번 더 막는 것들. `--tools` 만으로는 부족했다: 그 인자만 준 에이전트가
 *  실제로 파일을 만들었고(첫 실측), 목록에는 여전히 `Write` 가 남아 보인다. 겹쳐야 막힌다 */
export const CLAUDE_DISALLOWED = 'Write,Edit,NotebookEdit,Bash,PowerShell,Task,WebFetch,WebSearch'

export interface AgentArgsInput {
  provider: Provider
  model?: string
  effort?: string
  /** 이 계정의 codex 설정에 잡혀 있는 MCP 서버 이름들. codex 에서만 쓴다 — 아래 참조 */
  codexMcpServers?: string[]
}

/** 한 번의 생성에 쓰는 인자 벡터. 프롬프트는 여기 없다 — stdin 으로 간다. */
export function agentArgs(a: AgentArgsInput): string[] {
  return a.provider === 'codex' ? codexArgs(a) : claudeArgs(a)
}

function claudeArgs(a: AgentArgsInput): string[] {
  return [
    '-p',
    // 셋이 함께여야 막힌다 (위 상수들의 주석)
    '--permission-mode',
    'plan',
    '--tools',
    CLAUDE_TOOLS,
    '--disallowedTools',
    CLAUDE_DISALLOWED,
    // **사용자의 MCP 서버를 들이지 않는다.** 그것들은 이 앱이 고른 것이 아니고, 그 안에는 셸을
    // 그대로 내주는 것도 있다(serena 의 execute_shell_command). 이 한 줄이 없으면 위의 두 줄이
    // 막은 것을 MCP 도구가 그대로 통과시킨다 — 실측으로 이 인자가 `mcp__*` 를 전부 걷어 냈다
    '--strict-mcp-config',
    '--output-format',
    'json',
    ...(a.model ? ['--model', a.model] : []),
    ...(a.effort ? ['--effort', a.effort] : [])
  ]
}

function codexArgs(a: AgentArgsInput): string[] {
  return [
    'exec',
    '-s',
    'read-only',
    // git 저장소가 아닌 폴더도 이 앱은 프로젝트로 연다
    '--skip-git-repo-check',
    '--json',
    // **`-s read-only` 만으로는 막히지 않았다.** 이 사용자의 설정에는 `approvals_reviewer =
    // "auto_review"` 가 있었고, 그러면 샌드박스가 거절한 쓰기를 자동 검토가 승인해
    // workspace-write 로 올려 준다 — 실측에서 파일이 실제로 만들어졌다. 승인을 사람에게 되돌리고
    // (`user`) 물을 사람이 없게 하면(`never`) 그 자리에서 거절된다:
    //   "patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings"
    // 계정의 config.toml 이 무엇을 적어 두었든 CLI 인자가 이긴다.
    '-c',
    'approval_policy="never"',
    '-c',
    'approvals_reviewer="user"',
    // MCP 서버는 codex 가 띄우는 별도 프로세스라 위의 샌드박스 밖이다. claude 의
    // `--strict-mcp-config` 에 해당하는 한 방이 codex 에는 없어서(`-c mcp_servers={}` 는 표가
    // 병합돼 듣지 않는다, 실측) 이름마다 끈다.
    ...(a.codexMcpServers ?? []).flatMap((n) => ['-c', `mcp_servers.${n}.enabled=false`]),
    ...(a.model ? ['-m', a.model] : []),
    ...(a.effort ? ['-c', `model_reasoning_effort="${a.effort}"`] : [])
  ]
}

/** config.toml 에 잡힌 MCP 서버 이름들. **TOML 파서를 들이지 않는다** — 이 한 가지를 위해
 *  의존성을 늘릴 이유가 없고, 표 머리글은 줄 맨 앞에서 시작하는 한 줄이라 정규식으로 충분하다.
 *
 *  `[mcp_servers.serena]` 와 `[mcp_servers."google-sheets"]` 둘 다 받는다. `[mcp_servers.x.env]`
 *  같은 하위 표에서는 첫 마디만 가져오므로 같은 이름이 여러 번 나오고, 그래서 한 번만 남긴다. */
export function codexMcpServerNames(configToml: string): string[] {
  const names = new Set<string>()
  for (const m of configToml.matchAll(/^\s*\[mcp_servers\.("[^"]+"|'[^']+'|[^.\]\s]+)/gm)) {
    const raw = m[1]
    const name = /^["']/.test(raw) ? raw.slice(1, -1) : raw
    if (name) names.add(name)
  }
  return [...names]
}
