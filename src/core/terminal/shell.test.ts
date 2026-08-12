import { describe, it, expect } from 'vitest'
import { resolveShell } from './shell'

const has = (...present: string[]) => (file: string) => present.includes(file)

describe('resolveShell — win32', () => {
  it('pwsh가 있으면 pwsh를 쓴다', () => {
    expect(resolveShell('win32', has('pwsh.exe', 'powershell.exe', 'cmd.exe'))).toEqual({
      file: 'pwsh.exe',
      args: []
    })
  })

  it('pwsh가 없으면 powershell로 내려간다', () => {
    expect(resolveShell('win32', has('powershell.exe', 'cmd.exe'))).toEqual({
      file: 'powershell.exe',
      args: []
    })
  })

  it('powershell도 없으면 cmd로 내려간다', () => {
    expect(resolveShell('win32', has('cmd.exe'))).toEqual({ file: 'cmd.exe', args: [] })
  })

  it('후보가 전부 없으면 cmd.exe를 폴백으로 돌려준다', () => {
    expect(resolveShell('win32', () => false)).toEqual({ file: 'cmd.exe', args: [] })
  })

  it('exists는 후보 순서대로 조회된다 — 첫 성공에서 멈춘다', () => {
    const asked: string[] = []
    resolveShell('win32', (f) => {
      asked.push(f)
      return f === 'powershell.exe'
    })
    expect(asked).toEqual(['pwsh.exe', 'powershell.exe'])
  })
})

describe('resolveShell — non-win32', () => {
  it('envShell이 있으면 그것을 쓴다', () => {
    expect(resolveShell('linux', () => false, '/bin/zsh')).toEqual({ file: '/bin/zsh', args: [] })
  })

  it('envShell이 없으면 /bin/sh', () => {
    expect(resolveShell('linux', () => false)).toEqual({ file: '/bin/sh', args: [] })
  })

  it('envShell이 빈 문자열이면 /bin/sh (빈 값을 셸로 쓰지 않는다)', () => {
    expect(resolveShell('darwin', () => false, '')).toEqual({ file: '/bin/sh', args: [] })
  })

  it('non-win32에서는 exists를 조회하지 않는다', () => {
    let called = false
    resolveShell('linux', () => {
      called = true
      return true
    })
    expect(called).toBe(false)
  })
})
