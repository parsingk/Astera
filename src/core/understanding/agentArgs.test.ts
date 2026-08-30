// 이 벡터가 틀리면 남의 저장소에 파일이 써진다. 아래의 값들은 전부 실측으로 정한 것이라
// (agentArgs.ts 의 주석) 여기서는 "그 조합이 그대로 실려 나가는가"를 못박는다.
import { describe, it, expect } from 'vitest'
import { agentArgs, codexMcpServerNames, CLAUDE_DISALLOWED, CLAUDE_TOOLS } from './agentArgs'

/** ['-c', 'x=1'] 같은 짝을 한 문자열로 — 순서까지 함께 보기 위해서다 */
const pairs = (a: string[]): string[] => a.map((v, i) => (i > 0 ? `${a[i - 1]} ${v}` : v))

describe('claude — 쓰기를 막는 세 겹', () => {
  const args = agentArgs({ provider: 'claude' })

  it('plan 모드·도구 허용목록·이름 차단이 모두 있다', () => {
    expect(pairs(args)).toContain('--permission-mode plan')
    expect(pairs(args)).toContain(`--tools ${CLAUDE_TOOLS}`)
    expect(pairs(args)).toContain(`--disallowedTools ${CLAUDE_DISALLOWED}`)
  })

  // `--tools` 만으로는 막히지 않았다(실측) — 그래서 이름 차단이 함께 있어야 한다
  it('셸로 가는 길이 이름으로도 막혀 있다', () => {
    for (const t of ['Bash', 'PowerShell', 'Task', 'Write', 'Edit']) expect(CLAUDE_DISALLOWED).toContain(t)
  })

  // 사용자의 MCP 서버에는 셸을 그대로 내주는 것이 있다 — 그것이 들어오면 위의 셋이 무의미하다
  it('사용자의 MCP 서버를 들이지 않는다', () => {
    expect(args).toContain('--strict-mcp-config')
  })

  it('모델과 노력은 고른 때만 실린다', () => {
    expect(agentArgs({ provider: 'claude' }).join(' ')).not.toContain('--model')
    expect(pairs(agentArgs({ provider: 'claude', model: 'opus', effort: 'low' }))).toEqual(
      expect.arrayContaining(['--model opus', '--effort low'])
    )
  })
})

describe('codex — 샌드박스만으로는 막히지 않는다', () => {
  const args = agentArgs({ provider: 'codex' })

  it('읽기 전용 샌드박스를 켠다', () => {
    expect(pairs(args)).toContain('-s read-only')
  })

  // **이것이 이 파일의 핵심이다.** `approvals_reviewer = "auto_review"` 가 설정에 있으면
  // 샌드박스가 거절한 쓰기를 자동 검토가 승인해 파일이 실제로 만들어졌다(실측). 승인을
  // 사람에게 되돌리고 물을 사람이 없게 해야 그 자리에서 거절된다.
  it('자동 승인이 샌드박스를 넘지 못하게 한다', () => {
    expect(pairs(args)).toContain('-c approval_policy="never"')
    expect(pairs(args)).toContain('-c approvals_reviewer="user"')
  })

  it('계정에 잡힌 MCP 서버를 이름마다 끈다', () => {
    const p = pairs(agentArgs({ provider: 'codex', codexMcpServers: ['serena', 'google-sheets'] }))
    expect(p).toContain('-c mcp_servers.serena.enabled=false')
    expect(p).toContain('-c mcp_servers.google-sheets.enabled=false')
  })

  it('모델과 노력은 고른 때만 실린다', () => {
    expect(agentArgs({ provider: 'codex' }).join(' ')).not.toContain('model_reasoning_effort')
    const p = pairs(agentArgs({ provider: 'codex', model: 'gpt-5.6', effort: 'high' }))
    expect(p).toContain('-m gpt-5.6')
    expect(p).toContain('-c model_reasoning_effort="high"')
  })
})

describe('codexMcpServerNames', () => {
  it('표 머리글에서 이름을 뽑고, 하위 표는 겹쳐 세지 않는다', () => {
    const toml = [
      'model = "gpt-5.6"',
      '[mcp_servers.node_repl]',
      'command = "x"',
      '[mcp_servers.node_repl.env]',
      'CODEX_HOME = "y"',
      '[mcp_servers.serena]',
      'command = "z"',
      '[projects.\'d:\\p\']',
      'trust_level = "trusted"'
    ].join('\n')
    expect(codexMcpServerNames(toml)).toEqual(['node_repl', 'serena'])
  })

  it('따옴표로 감싼 이름도 읽는다', () => {
    expect(codexMcpServerNames('[mcp_servers."google-sheets"]\nurl = "u"')).toEqual(['google-sheets'])
  })

  it('MCP 가 없거나 파일을 읽지 못했으면 빈 목록이다', () => {
    expect(codexMcpServerNames('')).toEqual([])
    expect(codexMcpServerNames('model = "x"')).toEqual([])
  })
})
