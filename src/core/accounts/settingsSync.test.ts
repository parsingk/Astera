import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isHomeClaudeDir, syncClaudeSettings, syncCodexSettings } from './settingsSync'

let home: string
let target: string

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-sync-'))
  target = path.join(home, '.claude-accounts', 'claude3')
  await fs.mkdir(target, { recursive: true })
})

/** The source used to be hardcoded to the home account, and these cases still cover that shape */
const syncFromHome = (): ReturnType<typeof syncClaudeSettings> =>
  syncClaudeSettings(path.join(home, '.claude'), target, home)

async function writeHomeSettings(data: unknown): Promise<void> {
  await fs.mkdir(path.join(home, '.claude'), { recursive: true })
  await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify(data), 'utf8')
}

async function readTarget(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(target, name), 'utf8'))
}

describe('isHomeClaudeDir', () => {
  it('<home>/.claude만 홈 디렉토리로 판정한다 (대소문자·구분자 무시)', () => {
    expect(isHomeClaudeDir(home, path.join(home, '.claude'))).toBe(true)
    expect(isHomeClaudeDir(home, path.join(home, '.CLAUDE'))).toBe(true)
    expect(isHomeClaudeDir(home, target)).toBe(false)
  })
})

describe('syncClaudeSettings —settings.json 파트', () => {
  it('최상위 키 단위로 병합한다 — 같은 키는 기본 계정 우선, 대상 전용 키 유지', async () => {
    await writeHomeSettings({ theme: 'light', model: 'claude-fable-5' })
    await fs.writeFile(
      path.join(target, 'settings.json'),
      JSON.stringify({ theme: 'dark', skipDangerousModePermissionPrompt: true }),
      'utf8'
    )
    const r = await syncFromHome()
    expect(r.settingsApplied).toBe(true)
    expect(await readTarget('settings.json')).toEqual({
      theme: 'light',
      model: 'claude-fable-5',
      skipDangerousModePermissionPrompt: true
    })
  })

  it('중첩 객체(enabledPlugins 등)도 최상위 키 단위로 통째 교체한다', async () => {
    await writeHomeSettings({ enabledPlugins: { 'a@mkt': true } })
    await fs.writeFile(
      path.join(target, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'b@mkt': true } }),
      'utf8'
    )
    await syncFromHome()
    expect((await readTarget('settings.json')).enabledPlugins).toEqual({ 'a@mkt': true })
  })

  it('기본 계정 settings.json이 없으면 settings 파트를 스킵하고 대상을 건드리지 않는다', async () => {
    const original = JSON.stringify({ theme: 'dark' })
    await fs.writeFile(path.join(target, 'settings.json'), original, 'utf8')
    const r = await syncFromHome()
    expect(r.settingsApplied).toBe(false)
    expect(await fs.readFile(path.join(target, 'settings.json'), 'utf8')).toBe(original)
  })

  it('기본 계정 settings.json이 손상 JSON이면 settings 파트를 스킵한다', async () => {
    await fs.mkdir(path.join(home, '.claude'), { recursive: true })
    await fs.writeFile(path.join(home, '.claude', 'settings.json'), '{broken', 'utf8')
    const r = await syncFromHome()
    expect(r.settingsApplied).toBe(false)
  })

  it('대상 settings.json이 없으면 기본 계정 값으로 새로 만든다 (.bak 없음)', async () => {
    await writeHomeSettings({ theme: 'light' })
    const r = await syncFromHome()
    expect(r.settingsApplied).toBe(true)
    expect(await readTarget('settings.json')).toEqual({ theme: 'light' })
    await expect(fs.access(path.join(target, 'settings.json.bak'))).rejects.toThrow()
  })

  it('덮어쓰기 전 대상 settings.json을 .bak으로 백업한다', async () => {
    await writeHomeSettings({ theme: 'light' })
    const original = JSON.stringify({ theme: 'dark' })
    await fs.writeFile(path.join(target, 'settings.json'), original, 'utf8')
    await syncFromHome()
    expect(await fs.readFile(path.join(target, 'settings.json.bak'), 'utf8')).toBe(original)
  })

  it('대상 settings.json이 손상이면 .bak 보존 후 기본 계정 값만으로 작성한다', async () => {
    await writeHomeSettings({ theme: 'light' })
    await fs.writeFile(path.join(target, 'settings.json'), '{broken', 'utf8')
    const r = await syncFromHome()
    expect(r.settingsApplied).toBe(true)
    expect(await readTarget('settings.json')).toEqual({ theme: 'light' })
    expect(await fs.readFile(path.join(target, 'settings.json.bak'), 'utf8')).toBe('{broken')
  })
})

async function writeHomeSidecar(data: unknown): Promise<void> {
  await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify(data), 'utf8')
}

describe('syncClaudeSettings —mcpServers 파트', () => {
  it('서버 이름 단위로 병합한다 — 같은 이름은 기본 계정 우선, 대상 전용 서버 유지', async () => {
    await writeHomeSidecar({
      mcpServers: { atlassian: { type: 'http', url: 'https://mcp.atlassian.com/v1/mcp' } },
      oauthAccount: { email: 'home@example.com' }
    })
    await fs.writeFile(
      path.join(target, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          atlassian: { type: 'http', url: 'https://old.example' },
          mine: { type: 'stdio', command: 'mine.exe' }
        }
      }),
      'utf8'
    )
    const r = await syncFromHome()
    expect(r.mcpApplied).toBe(true)
    expect((await readTarget('.claude.json')).mcpServers).toEqual({
      atlassian: { type: 'http', url: 'https://mcp.atlassian.com/v1/mcp' },
      mine: { type: 'stdio', command: 'mine.exe' }
    })
  })

  it('대상 .claude.json의 mcpServers 외 키는 보존하고, 소스의 다른 키는 가져오지 않는다', async () => {
    await writeHomeSidecar({
      mcpServers: { serena: { type: 'stdio', command: 'serena.exe' } },
      oauthAccount: { email: 'home@example.com' }
    })
    await fs.writeFile(
      path.join(target, '.claude.json'),
      JSON.stringify({ oauthAccount: { email: 'claude3@example.com' }, projects: { 'D:/x': {} } }),
      'utf8'
    )
    await syncFromHome()
    const written = await readTarget('.claude.json')
    expect(written.oauthAccount).toEqual({ email: 'claude3@example.com' }) // 계정 정체성 불가침
    expect(written.projects).toEqual({ 'D:/x': {} })
    expect(written.mcpServers).toEqual({ serena: { type: 'stdio', command: 'serena.exe' } })
  })

  it('홈 사이드카가 없거나 mcpServers 키가 없으면 MCP 파트를 스킵하고 대상 파일을 만들지 않는다', async () => {
    const r1 = await syncFromHome()
    expect(r1.mcpApplied).toBe(false)
    await writeHomeSidecar({ oauthAccount: { email: 'home@example.com' } })
    const r2 = await syncFromHome()
    expect(r2.mcpApplied).toBe(false)
    await expect(fs.access(path.join(target, '.claude.json'))).rejects.toThrow()
  })

  it('덮어쓰기 전 대상 .claude.json을 .bak으로 백업한다', async () => {
    await writeHomeSidecar({ mcpServers: { serena: { type: 'stdio', command: 'serena.exe' } } })
    const original = JSON.stringify({ oauthAccount: { email: 'claude3@example.com' } })
    await fs.writeFile(path.join(target, '.claude.json'), original, 'utf8')
    await syncFromHome()
    expect(await fs.readFile(path.join(target, '.claude.json.bak'), 'utf8')).toBe(original)
  })
})

async function writeHomeContent(dir: string, rel: string, data: string): Promise<void> {
  const full = path.join(home, '.claude', dir, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, data, 'utf8')
}

async function readTargetFile(rel: string): Promise<string> {
  return fs.readFile(path.join(target, rel), 'utf8')
}

describe('syncClaudeSettings —콘텐츠 디렉토리 파트', () => {
  it('skills 트리를 대상으로 재귀 복사하고 contentApplied에 담는다', async () => {
    await writeHomeContent('skills', 'weekly/SKILL.md', 'name: weekly')
    await writeHomeContent('skills', 'weekly/lib/helper.js', 'export const x = 1')
    const r = await syncFromHome()
    expect(r.contentApplied).toContain('skills')
    expect(await readTargetFile('skills/weekly/SKILL.md')).toBe('name: weekly')
    expect(await readTargetFile('skills/weekly/lib/helper.js')).toBe('export const x = 1')
  })

  it('대상 전용 파일(생성된 reports 등)은 병합 후에도 보존한다', async () => {
    await writeHomeContent('skills', 'weekly/SKILL.md', 'name: weekly')
    const reportPath = path.join(target, 'skills', 'weekly', 'reports', 'r.md')
    await fs.mkdir(path.dirname(reportPath), { recursive: true })
    await fs.writeFile(reportPath, 'my report', 'utf8')
    await syncFromHome()
    expect(await readTargetFile('skills/weekly/reports/r.md')).toBe('my report')
    expect(await readTargetFile('skills/weekly/SKILL.md')).toBe('name: weekly')
  })

  it('동명 파일은 소스 내용으로 덮어쓴다', async () => {
    await writeHomeContent('skills', 'weekly/SKILL.md', 'name: new')
    const dest = path.join(target, 'skills', 'weekly', 'SKILL.md')
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.writeFile(dest, 'name: old', 'utf8')
    await syncFromHome()
    expect(await readTargetFile('skills/weekly/SKILL.md')).toBe('name: new')
  })

  it('소스 디렉토리가 없으면 스킵하고 대상 폴더를 만들지 않으며 contentApplied에서 제외한다', async () => {
    const r = await syncFromHome()
    expect(r.contentApplied).not.toContain('skills')
    await expect(fs.access(path.join(target, 'skills'))).rejects.toThrow()
  })

  it('대상 콘텐츠 디렉토리가 없어도 소스로부터 새로 생성한다', async () => {
    await writeHomeContent('commands', 'foo.md', 'cmd')
    const r = await syncFromHome()
    expect(r.contentApplied).toContain('commands')
    expect(await readTargetFile('commands/foo.md')).toBe('cmd')
  })

  it('skills·commands·agents를 모두 순회한다', async () => {
    await writeHomeContent('skills', 's.md', 'a')
    await writeHomeContent('commands', 'c.md', 'b')
    await writeHomeContent('agents', 'g.md', 'c')
    const r = await syncFromHome()
    expect(r.contentApplied.sort()).toEqual(['agents', 'commands', 'skills'])
  })
})

// The source is no longer always the home account — it is whichever account is that provider's default,
// which is usually but not necessarily the home one.
describe('syncClaudeSettings — 원본이 홈이 아닌 계정일 때', () => {
  let src: string

  beforeEach(async () => {
    src = path.join(home, '.claude-accounts', 'claude1')
    await fs.mkdir(src, { recursive: true })
  })

  it('MCP를 홈 사이드카가 아니라 원본 계정 폴더의 .claude.json에서 읽는다', async () => {
    // 홈 사이드카에도 값을 심어 둔다 — 경로 분기가 틀리면 이 값이 새어 들어와 바로 드러난다
    await writeHomeSidecar({ mcpServers: { fromHome: { type: 'stdio', command: 'home.exe' } } })
    await fs.writeFile(
      path.join(src, '.claude.json'),
      JSON.stringify({ mcpServers: { fromSrc: { type: 'stdio', command: 'src.exe' } } }),
      'utf8'
    )
    const r = await syncClaudeSettings(src, target, home)
    expect(r.mcpApplied).toBe(true)
    expect((await readTarget('.claude.json')).mcpServers).toEqual({
      fromSrc: { type: 'stdio', command: 'src.exe' }
    })
  })

  it('settings.json과 콘텐츠 디렉토리도 원본 계정 폴더에서 가져온다', async () => {
    await fs.writeFile(path.join(src, 'settings.json'), JSON.stringify({ theme: 'src' }), 'utf8')
    await fs.mkdir(path.join(src, 'skills'), { recursive: true })
    await fs.writeFile(path.join(src, 'skills', 's.md'), 'from src', 'utf8')
    // 홈에도 다른 값을 둬서, 홈을 읽으면 실패하도록 한다
    await writeHomeSettings({ theme: 'home' })
    await writeHomeContent('skills', 's.md', 'from home')

    const r = await syncClaudeSettings(src, target, home)
    expect(r.settingsApplied).toBe(true)
    expect(await readTarget('settings.json')).toEqual({ theme: 'src' })
    expect(await readTargetFile('skills/s.md')).toBe('from src')
  })
})

describe('syncCodexSettings', () => {
  let src: string
  let dst: string

  beforeEach(async () => {
    src = path.join(home, '.codex')
    dst = path.join(home, '.codex-accounts', 'codex2')
    await fs.mkdir(src, { recursive: true })
    await fs.mkdir(dst, { recursive: true })
  })

  it('config.toml을 통째로 대체하고 기존 파일을 .bak으로 남긴다', async () => {
    await fs.writeFile(path.join(src, 'config.toml'), 'model = "src"\n', 'utf8')
    await fs.writeFile(path.join(dst, 'config.toml'), 'model = "old"\n', 'utf8')
    const r = await syncCodexSettings(src, dst)
    expect(r.settingsApplied).toBe(true)
    expect(await fs.readFile(path.join(dst, 'config.toml'), 'utf8')).toBe('model = "src"\n')
    expect(await fs.readFile(path.join(dst, 'config.toml.bak'), 'utf8')).toBe('model = "old"\n')
  })

  it('대상에 config.toml이 없으면 새로 만들고 .bak은 남기지 않는다', async () => {
    await fs.writeFile(path.join(src, 'config.toml'), 'model = "src"\n', 'utf8')
    const r = await syncCodexSettings(src, dst)
    expect(r.settingsApplied).toBe(true)
    expect(await fs.readFile(path.join(dst, 'config.toml'), 'utf8')).toBe('model = "src"\n')
    await expect(fs.access(path.join(dst, 'config.toml.bak'))).rejects.toThrow()
  })

  it('원본에 config.toml이 없으면 아무것도 하지 않는다', async () => {
    await fs.writeFile(path.join(dst, 'config.toml'), 'model = "keep"\n', 'utf8')
    const r = await syncCodexSettings(src, dst)
    expect(r.settingsApplied).toBe(false)
    expect(await fs.readFile(path.join(dst, 'config.toml'), 'utf8')).toBe('model = "keep"\n')
  })

  it('auth.json과 sessions는 손대지 않는다 — 자격증명·기록은 복사 대상이 아니다', async () => {
    await fs.writeFile(path.join(src, 'config.toml'), 'model = "src"\n', 'utf8')
    await fs.writeFile(path.join(src, 'auth.json'), '{"tokens":{"id_token":"SRC"}}', 'utf8')
    await fs.mkdir(path.join(src, 'sessions'), { recursive: true })
    await fs.writeFile(path.join(src, 'sessions', 's.jsonl'), 'src session', 'utf8')
    await fs.writeFile(path.join(dst, 'auth.json'), '{"tokens":{"id_token":"DST"}}', 'utf8')

    await syncCodexSettings(src, dst)
    expect(await fs.readFile(path.join(dst, 'auth.json'), 'utf8')).toBe('{"tokens":{"id_token":"DST"}}')
    await expect(fs.access(path.join(dst, 'sessions'))).rejects.toThrow()
  })
})
