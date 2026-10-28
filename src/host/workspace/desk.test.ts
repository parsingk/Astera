import { describe, it, expect } from 'vitest'
import { START_TIME_TOLERANCE_MS } from '../../core/workspace/lifecycle'
import { DESK_PS1 } from './desk'

// The script itself runs only on Windows (Task 3's live test below, and Task 10). These pin the two
// traps the spike paid for (docs/agent-workspace-isolation.md, Pointers) and the shape the client reads.
describe('DESK_PS1', () => {
  it('is ASCII, so Windows PowerShell 5.1 reads the BOM-less file the same in every code page', () => {
    expect([...DESK_PS1].every((c) => c.charCodeAt(0) < 128)).toBe(true)
  })

  it('passes null strings as [NullString]::Value, never $null (the ERROR_PATH_NOT_FOUND trap)', () => {
    expect(DESK_PS1).toContain('[NullString]::Value')
    expect(DESK_PS1).not.toMatch(/\$cwd\s*=\s*\$null/)
  })

  it('reports an Add-Type failure as a fatal line before ready, instead of failing silently', () => {
    const fatal = DESK_PS1.indexOf('fatal =')
    const ready = DESK_PS1.indexOf('ready = $true')
    expect(fatal).toBeGreaterThan(0)
    expect(ready).toBeGreaterThan(fatal)
    expect(DESK_PS1).toContain('Add-Type')
  })

  it('uses the calls the spike measured', () => {
    for (const call of ['CreateDesktop', 'SetThreadDesktop', 'EnumDesktopWindows', 'PrintWindow', 'PostMessage', 'CloseDesktop', 'GetProcessTimes', 'WSF_VISIBLE'])
      expect(DESK_PS1, call).toContain(call)
    expect(DESK_PS1).toContain('PW_RENDERFULLCONTENT = 2')
  })

  it('never launches on the person desktop: no desktop name is a refusal, not the default desktop', () => {
    expect(DESK_PS1).toContain('no desktop to launch on')
    expect(DESK_PS1).toContain('string.IsNullOrEmpty(desktop)')
  })

  it('writes every message with -InputObject, so a one element array is not unwrapped', () => {
    expect(DESK_PS1).toContain('ConvertTo-Json -InputObject')
  })

  it('answers a failed request with the innermost message, not PowerShell\'s localized "Exception calling" wrapper', () => {
    expect(DESK_PS1).toContain('while ($err.InnerException) { $err = $err.InnerException }')
    expect(DESK_PS1).toContain('error = ($err.Message')
  })

  it('attaches a fresh thread to the desktop, since PowerShell\'s own STA thread owns windows (ERROR_BUSY)', () => {
    expect(DESK_PS1).toContain('static T OnDesk<T>(IntPtr desk, Func<T> f)')
    expect(DESK_PS1).toContain('new Thread(')
  })

  it('kills only the process launched: a pid whose start time differs by more than the lifecycle tolerance is skipped', () => {
    expect(DESK_PS1).toContain(`$tolerance = ${String(START_TIME_TOLERANCE_MS)}`)
    expect(DESK_PS1).toContain('[AsteraDesk]::StartedAtOf([int]$req.pid)')
    expect(DESK_PS1).toContain('[Math]::Abs($live - [int64]$req.startedAt) -gt $tolerance')
    expect(DESK_PS1).toContain('start time mismatch')
    expect(DESK_PS1.indexOf('start time mismatch')).toBeLessThan(DESK_PS1.indexOf('taskkill /T /F /PID'))
  })

  it('launches suspended, puts the process in a job of its own, and only then resumes it', () => {
    expect(DESK_PS1).toContain('CREATE_SUSPENDED = 0x00000004')
    expect(DESK_PS1).toContain('CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | CREATE_SUSPENDED')
    const launch = DESK_PS1.slice(DESK_PS1.indexOf('public static AsteraLaunch Launch('))
    const order = ['CreateProcess(', 'JobFor(pi.hProcess)', 'ResumeThread(pi.hThread)'].map((s) => launch.indexOf(s))
    expect(order.every((i) => i > 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    const jobFor = DESK_PS1.slice(DESK_PS1.indexOf('static IntPtr JobFor('))
    const steps = ['CreateJobObject(', 'SetInformationJobObject(job, JobObjectExtendedLimitInformation', 'AssignProcessToJobObject(job, process)'].map((s) => jobFor.indexOf(s))
    expect(steps.every((i) => i > 0)).toBe(true)
    expect(steps).toEqual([...steps].sort((a, b) => a - b))
  })

  it('makes a job that ends the whole tree when its last handle closes, and lets nothing break away from it', () => {
    expect(DESK_PS1).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000')
    expect(DESK_PS1).toContain('JobObjectExtendedLimitInformation = 9')
    expect(DESK_PS1).toContain('info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;')
    expect(DESK_PS1).not.toMatch(/BREAKAWAY_OK/)
  })

  it('still launches when the job cannot be made, and the reply says so with the reason', () => {
    expect(DESK_PS1).toContain('catch (Exception e) { r.JobError = e.Message; }')
    expect(DESK_PS1).toContain('job = $r.Job')
    expect(DESK_PS1).toContain('if (-not $r.Job) { $value.jobError = $r.JobError }')
  })

  it('never leaves a suspended process behind: one whose thread does not resume is ended and the launch fails', () => {
    expect(DESK_PS1).toContain('"ResumeThread failed: "')
    expect(DESK_PS1).toMatch(/if \(!resumed\) \{\s*TerminateProcess\(pi\.hProcess, 1\);/)
  })

  it('kill ends the launch job and closes its handle, and falls back to taskkill /T only when it holds none', () => {
    const kill = DESK_PS1.slice(DESK_PS1.indexOf("'kill' {"))
    const endJob = kill.indexOf('[AsteraDesk]::EndJob([int]$req.pid, [int64]$req.startedAt, $tolerance)')
    expect(endJob).toBeGreaterThan(0)
    expect(endJob).toBeLessThan(kill.indexOf('taskkill /T /F /PID'))
    expect(DESK_PS1).toMatch(/TerminateJobObject\(j\.Handle, 1\);\s*CloseHandle\(j\.Handle\);/)
  })

  it('keeps its escapes as text: no CR byte, and the regex still says \\r\\n', () => {
    expect(DESK_PS1.includes(String.fromCharCode(13))).toBe(false)
    expect(DESK_PS1).toContain('[\\r\\n]+')
  })
})
