import { describe, expect, it } from 'vitest'
import { codexEnforceArgs, codexHookHash } from './codexEnforce'

// Enforce in a Codex session (enforce design §5): the blocking hook and its trust ride on `-c`, written nowhere
describe('codexEnforceArgs', () => {
  const spike = 'node "C:/s/hook.cjs" "C:/s/log.jsonl"'

  it('builds the hook and its trust as the measured spike did', () => {
    // The spike's own method (Python json.dumps sort_keys, compact, ensure_ascii=False), computed 2026-10-27; Codex 0.160
    // ran the hook it trusted with it
    expect(codexHookHash(spike)).toBe('sha256:c01926dea9a2db8c011fad4e33a4fe1b671220120abda117602bfaa230947b79')
    const args = codexEnforceArgs({ command: spike, platform: 'win32' })
    expect(args).toEqual([
      '-c',
      'hooks.PreToolUse=[{matcher="*",hooks=[{type="command",command="node \\"C:/s/hook.cjs\\" \\"C:/s/log.jsonl\\"",timeout=10}]}]',
      '-c',
      "hooks.state={'C:\\<session-flags>\\config.toml:pre_tool_use:0:0'={trusted_hash=\"sha256:c01926dea9a2db8c011fad4e33a4fe1b671220120abda117602bfaa230947b79\"}," +
        "'C:\\<session-flags>/config.toml:pre_tool_use:0:0'={trusted_hash=\"sha256:c01926dea9a2db8c011fad4e33a4fe1b671220120abda117602bfaa230947b79\"}}"
    ])
  })

  it('passes both Windows sources and one elsewhere', () => {
    const keys = (platform: NodeJS.Platform): string[] =>
      [...codexEnforceArgs({ command: spike, platform })[3].matchAll(/'([^']+)'=/g)].map((m) => m[1])
    expect(keys('win32')).toEqual(['C:\\<session-flags>\\config.toml:pre_tool_use:0:0', 'C:\\<session-flags>/config.toml:pre_tool_use:0:0'])
    expect(keys('darwin')).toEqual(['/<session-flags>/config.toml:pre_tool_use:0:0'])
    expect(keys('linux')).toEqual(['/<session-flags>/config.toml:pre_tool_use:0:0'])
  })

  it('hashes a command with non-ASCII and escaped characters the way the spike’s JSON does', () => {
    // json.dumps(..., ensure_ascii=False) keeps Hangul as it is and escapes `"` and `\` as JSON does (computed 2026-10-27)
    expect(codexHookHash('"C:\\사용자\\astera-host.exe" "C:\\p\\astera-enforce-hook.cjs" codex')).toBe(
      'sha256:c46aa67b20f01c934c4f41890e358e6c9ffc6eca397c1be872522764bc50a1b9'
    )
  })

  it('carries single quotes, backslashes and control characters in a TOML basic string', () => {
    // captureCommand's Windows form is single-quoted, so the command is a basic string, escaped, never a literal one
    const [, pre] = codexEnforceArgs({ command: "C:'/rt/astera-host.exe' 'C:\\p\\o\"k\thook.cjs' codex", platform: 'win32' })
    expect(pre).toBe(
      'hooks.PreToolUse=[{matcher="*",hooks=[{type="command",command="C:\'/rt/astera-host.exe\' \'C:\\\\p\\\\o\\"k\\u0009hook.cjs\' codex",timeout=10}]}]'
    )
  })
})
