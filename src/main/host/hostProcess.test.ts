import { describe, it, expect } from 'vitest'
import { executableProbe, parseExecutablePath, hostKillPlan, killHostCommand } from './hostProcess'

describe('executableProbe', () => {
  it('asks Windows through PowerShell, with no profile to slow it down', () => {
    const p = executableProbe('win32', 78672)
    expect(p?.file).toBe('powershell.exe')
    expect(p?.args.join(' ')).toContain('78672')
    expect(p?.args).toContain('-NoProfile')
  })

  it('asks macOS through ps', () => {
    const p = executableProbe('darwin', 4242)
    expect(p).toEqual({ file: 'ps', args: ['-p', '4242', '-o', 'comm='] })
  })

  // linux answers from /proc without running anything, so there is no command to give.
  it('has nothing to run on linux', () => {
    expect(executableProbe('linux', 4242)).toBeNull()
  })
})

describe('parseExecutablePath', () => {
  it('takes the first non-empty line and trims it', () => {
    expect(parseExecutablePath('C:\\Users\\x\\node.exe\r\n')).toBe('C:\\Users\\x\\node.exe')
    expect(parseExecutablePath('\n  /Applications/Astera.app/Contents/MacOS/Astera  \n')).toBe(
      '/Applications/Astera.app/Contents/MacOS/Astera'
    )
  })

  // A pid that is gone makes `Get-Process` write to stderr and nothing to stdout, and `ps` print only
  // its header. Both reach here as nothing, which must not read as a path.
  it('is null for nothing at all', () => {
    expect(parseExecutablePath('')).toBeNull()
    expect(parseExecutablePath('   \r\n  \n')).toBeNull()
  })
})

describe('hostKillPlan', () => {
  const expected = 'C:\\Users\\x\\AppData\\Local\\astera\\host-runtime\\node-24.15.0\\node.exe'

  it('ends a process whose executable is the one this app starts a Host with', () => {
    expect(hostKillPlan({ platform: 'win32', expectedExe: expected, actualExe: expected })).toBe('kill')
  })

  // Windows paths differ in case and in separators between what `process.execPath` reports and what
  // `Get-Process` prints; neither difference is a different file.
  it('ignores case and separators on win32', () => {
    expect(
      hostKillPlan({
        platform: 'win32',
        expectedExe: 'C:/Users/x/AppData/Local/astera/host-runtime/node-24.15.0/node.exe',
        actualExe: expected.toUpperCase()
      })
    ).toBe('kill')
  })

  it('keeps case on linux, where two names that differ in case are two files', () => {
    expect(hostKillPlan({ platform: 'linux', expectedExe: '/opt/astera/astera', actualExe: '/opt/astera/Astera' })).toBe(
      'skip-mismatch'
    )
  })

  // darwin's default APFS volume ignores case like NTFS does — the project-wide rule (foldPathCase).
  it('ignores case on darwin', () => {
    expect(hostKillPlan({ platform: 'darwin', expectedExe: '/opt/astera/astera', actualExe: '/opt/astera/Astera' })).toBe(
      'kill'
    )
  })

  // **The reason this function exists.** A pid outlives the process it named and Windows hands the
  // number out again, so the pid in a file left behind by a Host that died badly can belong to
  // anything by the time somebody presses the button.
  it('refuses a pid that is now something else', () => {
    expect(hostKillPlan({ platform: 'win32', expectedExe: expected, actualExe: 'C:\\Windows\\System32\\notepad.exe' })).toBe(
      'skip-mismatch'
    )
  })

  it('reports a pid that no longer exists, which is nothing to end and nothing to worry about', () => {
    expect(hostKillPlan({ platform: 'win32', expectedExe: expected, actualExe: null })).toBe('skip-gone')
  })

  // The probe can fail for reasons that are not about the process: PowerShell missing, a permission
  // refusal, a timeout. `actualExe` is null for those too, and "I could not look" must never become
  // "end it anyway".
  it('refuses when the executable could not be read at all', () => {
    expect(hostKillPlan({ platform: 'darwin', expectedExe: '/opt/a', actualExe: null })).toBe('skip-gone')
  })
})

describe('killHostCommand', () => {
  it('takes the tree down on win32, where the Host has conhost children', () => {
    expect(killHostCommand('win32', 78672)).toEqual({ file: 'taskkill', args: ['/pid', '78672', '/T', '/F'] })
  })

  // posix has `process.kill`, and spawning a binary to do what the runtime already does would only add
  // a way to fail.
  it('has nothing to run on posix', () => {
    expect(killHostCommand('darwin', 1)).toBeNull()
    expect(killHostCommand('linux', 1)).toBeNull()
  })
})
