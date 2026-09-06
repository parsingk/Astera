import { describe, it, expect } from 'vitest'
import { buildClaudeCommand, buildCodexCommand } from './commands'

describe('initialPrompt', () => {
  it('claude: 마지막 위치 인자로 싣는다', () => {
    const { file, args } = buildClaudeCommand('linux')({ initialPrompt: 'C:/u/orch/specs/a.md 를 읽어라' })
    expect(file).toBe('claude')
    expect(args.at(-1)).toBe('C:/u/orch/specs/a.md 를 읽어라')
  })
  it('codex: 마지막 위치 인자로 싣는다', () => {
    const { args } = buildCodexCommand('linux')({ initialPrompt: 'C:/u/orch/specs/a.md 를 읽어라' })
    expect(args.at(-1)).toBe('C:/u/orch/specs/a.md 를 읽어라')
  })
  it('win32에서도 cmd.exe 래핑의 마지막에 온다', () => {
    const { file, args } = buildClaudeCommand('win32')({ initialPrompt: 'C:/u/orch/specs/a.md 를 읽어라' })
    expect(file).toBe('cmd.exe')
    expect(args.at(-1)).toBe('C:/u/orch/specs/a.md 를 읽어라')
  })
  it('initialPrompt는 sanitize하지 않는다 — 경로가 깨지면 안 된다', () => {
    const p = 'C:/u/orch/specs/tsk_1-dsp_1.md 를 읽고 그 지시를 따르라'
    expect(buildCodexCommand('win32')({ initialPrompt: p }).args.at(-1)).toBe(p)
  })
  it('resumeSessionId와 함께 오면 resume 인자 뒤에 온다', () => {
    const { args } = buildCodexCommand('linux')({
      resumeSessionId: 'sid',
      initialPrompt: 'do it'
    })
    expect(args.indexOf('resume')).toBeLessThan(args.indexOf('do it'))
  })
  it('없으면 인자가 늘지 않는다', () => {
    expect(buildClaudeCommand('linux')({}).args).toEqual([])
  })
})

describe('claude --add-dir', () => {
  it('grants read access to the given directories, variadically, before the prompt', () => {
    const { args } = buildClaudeCommand('linux')({ addDirs: ['/data/shots'], initialPrompt: 'fix it' })
    expect(args.slice(0, 2)).toEqual(['--add-dir', '/data/shots'])
    expect(args.indexOf('--add-dir')).toBeLessThan(args.indexOf('fix it'))
  })
  it('emits nothing when there are no directories', () => {
    expect(buildClaudeCommand('linux')({}).args).toEqual([])
    expect(buildClaudeCommand('linux')({ addDirs: [] }).args).toEqual([])
  })
  it('carries a win32 path through the cmd.exe wrapper', () => {
    const { file, args } = buildClaudeCommand('win32')({ addDirs: ['C:\Users\me\AppData\Roaming\astera-dev\preview\shots'] })
    expect(file).toBe('cmd.exe')
    expect(args).toContain('C:\Users\me\AppData\Roaming\astera-dev\preview\shots')
  })
  it('codex ignores addDirs — it reads those paths without a prompt', () => {
    expect(buildCodexCommand('linux')({ addDirs: ['/data/shots'] }).args).not.toContain('--add-dir')
  })
})
