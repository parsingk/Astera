import { describe, expect, it } from 'vitest'
import { claudeSandboxSettings } from './claudeSettings'

describe('claudeSandboxSettings', () => {
  it('turns Claude’s sandbox on strictly on macOS and Linux, with astera outside it', () => {
    const s = claudeSandboxSettings({ platform: 'linux', denied: ['/h/.ssh'], npmCache: '/t/astera-npm-cache' })
    expect(s.sandbox).toEqual({ enabled: true, allowUnsandboxedCommands: false, failIfUnavailable: true, excludedCommands: ['astera *'], filesystem: { allowWrite: ['/t/astera-npm-cache'], denyRead: ['/h/.ssh'] } })
    expect(s.permissions.deny).toEqual(['Read(//h/.ssh/**)'])
  })

  it('on Windows gives deny rules only, in Claude’s POSIX form', () => {
    const s = claudeSandboxSettings({ platform: 'win32', denied: ['C:/Users/a/.ssh'], npmCache: 'C:/t/astera-npm-cache' })
    expect(s.sandbox).toBeUndefined()
    expect(s.permissions.deny).toEqual(['Read(//c/Users/a/.ssh/**)'])
  })
})
