// The shell a sandboxed Task's check runs its line in, inside `codex sandbox` (Task K). Fix round 2: on Windows it prints
// the runner's mark as a line of its own before the check runs, so the runner knows the check started (checkRunner.ts).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CHECK_STARTED_MARK } from './checkRunner'
import { checkShell } from './checkShell'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'astera-checkshell-'))
  dirs.push(d)
  return d
}

describe('checkShell', () => {
  it('a Windows line says the check started before it runs, on the command line or first in its script', () => {
    const dir = tmp()
    expect(checkShell('win32', 'npm run test', dir, CHECK_STARTED_MARK)).toEqual(['cmd.exe', '/d', '/s', '/c', `echo ${CHECK_STARTED_MARK}& npm run test`])
    const quoted = checkShell('win32', 'python "my script.py"', dir, CHECK_STARTED_MARK)
    expect(quoted.slice(0, 3)).toEqual(['cmd.exe', '/d', '/c'])
    expect(readFileSync(quoted[3], 'utf8')).toBe(`@echo off\r\necho ${CHECK_STARTED_MARK}\r\npython "my script.py"\r\nexit /b %ERRORLEVEL%\r\n`)
  })

  it('without a mark, and off Windows, the line as before', () => {
    const dir = tmp()
    expect(checkShell('win32', 'npm test', dir)).toEqual(['cmd.exe', '/d', '/s', '/c', 'npm test'])
    expect(checkShell('linux', 'npm test', dir, CHECK_STARTED_MARK)).toEqual(['sh', '-c', 'npm test'])
    // The same line with and without the mark is two scripts, never one rewritten under a check that is running
    const a = checkShell('win32', 'python "x.py"', dir)[3]
    const b = checkShell('win32', 'python "x.py"', dir, CHECK_STARTED_MARK)[3]
    expect(a).not.toBe(b)
  })
})
