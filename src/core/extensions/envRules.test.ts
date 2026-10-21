// Agent Control Plane release 1 (design D11): which environment names a shared MCP server may use. A name that steers
// the CLIs themselves is refused; a name two servers need with different values cannot be delivered twice; a name
// tools inside the session also read is allowed with a warning.
import { describe, it, expect } from 'vitest'
import { envNameRefusal, envNameWarning, looksSecret } from './envRules'

describe('envNameRefusal', () => {
  it('refuses names that steer the Claude or Codex CLI', () => {
    for (const n of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CODEX_HOME', 'openai_base_url'])
      expect(envNameRefusal(n, 'v', new Map())).toBe('cli-env-name')
  })
  it('refuses a name another shared server already gives a different value', () => {
    expect(envNameRefusal('API_KEY', 'b', new Map([['API_KEY', 'a']]))).toBe('env-name-clash')
    expect(envNameRefusal('API_KEY', 'a', new Map([['API_KEY', 'a']]))).toBeNull()
  })
  it('allows ordinary names', () => {
    expect(envNameRefusal('LINEAR_API_KEY', 'v', new Map())).toBeNull()
  })
})

describe('envNameWarning', () => {
  it('warns for tokens tools inside a session also read', () => {
    expect(envNameWarning('GITHUB_TOKEN')).toBe('session-tools')
    expect(envNameWarning('LINEAR_API_KEY')).toBeNull()
  })
})

describe('looksSecret', () => {
  it('takes credential-looking names as secret by default', () => {
    for (const n of ['GITHUB_TOKEN', 'LINEAR_API_KEY', 'DB_PASSWORD', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_CREDENTIALS']) expect(looksSecret(n)).toBe(true)
    for (const n of ['LOG_LEVEL', 'PORT', 'NODE_ENV']) expect(looksSecret(n)).toBe(false)
  })
})

// Final review I2: a name the session's own process depends on is never overwritten by a shared server
describe('envNameRefusal, process names', () => {
  it('refuses the names the CLI process itself needs, in any letter case, and Astera\u2019s own', () => {
    for (const n of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'COMSPEC', 'NODE_OPTIONS', 'TEMP', 'TMP', 'ASTERA_SESSION', 'astera_cli'])
      expect(envNameRefusal(n, 'v', new Map()), n).toBe('process-env-name')
  })
})
