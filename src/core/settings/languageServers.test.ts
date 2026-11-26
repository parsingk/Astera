import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { interpreterPathProblem, languageServerPathProblem, languageServersOf, readLanguageServers } from './languageServers'

// Phase 3 Part 3: the "언어 서버" settings in app-settings.json, narrowed the same way by main's store and the Host
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('languageServersOf', () => {
  it('turns the stored record into settings, both languages on by default', () => {
    expect(languageServersOf(undefined)).toEqual({ typescript: { enabled: true }, python: { enabled: true, venvProjects: [] } })
    expect(languageServersOf('x')).toEqual({ typescript: { enabled: true }, python: { enabled: true, venvProjects: [] } })
    const tsc = path.resolve('ts', 'tsc.exe')
    const py = path.resolve('py', 'python.exe')
    const proj = path.resolve('proj')
    expect(
      languageServersOf({
        typescript: { enabled: false, path: tsc },
        python: { enabled: 'no', path: 'relative/langserver.index.js', interpreter: py, venvProjects: [proj, 'relative', 3] }
      })
    ).toEqual({ typescript: { enabled: false, path: tsc }, python: { enabled: true, interpreter: py, venvProjects: [proj] } })
  })

  it('reads the defaults from a missing file, and the record from a written one', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'astera-lsp-settings-'))
    dirs.push(dir)
    const file = path.join(dir, 'app-settings.json')
    expect(await readLanguageServers(file)).toEqual({ typescript: { enabled: true }, python: { enabled: true, venvProjects: [] } })
    writeFileSync(file, JSON.stringify({ languageServers: { python: { enabled: false } } }))
    expect((await readLanguageServers(file)).python.enabled).toBe(false)
  })
})

describe('languageServerPathProblem', () => {
  it('refuses a relative path and a TypeScript path that is not tsc', () => {
    expect(languageServerPathProblem('typescript', 'tsc')).not.toBeNull()
    expect(languageServerPathProblem('typescript', path.resolve('x', 'node.exe'))).not.toBeNull()
    expect(languageServerPathProblem('typescript', path.resolve('ts', 'tsc.exe'))).toBeNull()
    expect(languageServerPathProblem('typescript', path.resolve('ts', 'tsc'))).toBeNull()
    expect(languageServerPathProblem('python', path.resolve('p', 'langserver.index.js'))).toBeNull()
    expect(languageServerPathProblem('python', path.resolve('p', 'pyright.js'))).not.toBeNull()
    expect(languageServerPathProblem('python', 'langserver.index.js')).not.toBeNull()
  })
})

// Final review M13: the field kept showing an interpreter the settings silently dropped
describe('interpreterPathProblem', () => {
  it('refuses a relative interpreter and a batch file, and takes an absolute one', () => {
    expect(interpreterPathProblem('python.exe')).toMatch(/absolute/)
    expect(interpreterPathProblem(path.resolve('py', 'python.cmd'))).toMatch(/batch/)
    expect(interpreterPathProblem(path.resolve('py', 'PYTHON.BAT'))).toMatch(/batch/)
    expect(interpreterPathProblem(path.resolve('py', 'python.exe'))).toBeNull()
  })
})
