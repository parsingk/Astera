import { describe, it, expect } from 'vitest'
import { sandboxSetupAccountOf, sandboxSetupOutcome, spawnErrorMessage } from './spawnErrors'

describe('spawnErrorMessage', () => {
  // 2026-09-28 화면 검증: 고른 폴더가 시작 전에 사라지면 IPC 원문이 그대로 토스트에 떴다.
  it('앱이 낸 CWD_MISSING 을 폴더 경로가 든 문구로 바꾼다', () => {
    expect(
      spawnErrorMessage("Error invoking remote method 'sessions.spawn': Error: CWD_MISSING: /tmp/a b/gone")
    ).toEqual({ key: 'session.spawn.cwdMissing', params: { path: '/tmp/a b/gone' } })
  })

  it('Host 가 낸 CWD_MISSING 의 꼬리말(does not exist)은 경로에 넣지 않는다', () => {
    expect(spawnErrorMessage('Error: CWD_MISSING: C:\\work\\gone does not exist')).toEqual({
      key: 'session.spawn.cwdMissing',
      params: { path: 'C:\\work\\gone' }
    })
  })

  // Enforce (enforce design E5): a session that cannot be protected does not start, and says why
  it('says why an Enforce session did not start, with the CLI and its versions', () => {
    const raw = (code: string): string => `Error invoking remote method 'sessions.spawn': Error: ENFORCE_UNAVAILABLE: ${code}`
    expect(spawnErrorMessage(raw('no-interpreter'))).toEqual({ key: 'session.spawn.enforce.noInterpreter' })
    expect(spawnErrorMessage(raw('cli-too-old claude 2.1.300 2.1.306'))).toEqual({
      key: 'session.spawn.enforce.cliTooOld',
      params: { cli: 'Claude Code', found: '2.1.300', min: '2.1.306' }
    })
    expect(spawnErrorMessage(raw('cli-version-unknown codex'))).toEqual({ key: 'session.spawn.enforce.cliVersionUnknown', params: { cli: 'Codex' } })
    expect(spawnErrorMessage(raw('hook-missing'))).toEqual({ key: 'session.spawn.enforce.hookMissing' })
    // Final review C2, M2, M11
    expect(spawnErrorMessage(raw('hooks-off'))).toEqual({ key: 'session.spawn.enforce.hooksOff' })
    expect(spawnErrorMessage(raw('hook-write-failed'))).toEqual({ key: 'session.spawn.enforce.hookWriteFailed' })
    expect(spawnErrorMessage(raw('cli-missing codex'))).toEqual({ key: 'session.spawn.enforce.cliMissing', params: { cli: 'Codex' } })
    expect(spawnErrorMessage(raw('codex-daemon'))).toEqual({ key: 'session.spawn.enforce.codexDaemon' })
    // The Host's own error, through `astera`
    expect(spawnErrorMessage('ENFORCE_UNAVAILABLE: cli-too-old codex 0.159.0 0.160.0')).toMatchObject({ params: { cli: 'Codex' } })
  })

  // Sandbox design §6 (E5): a profile's sandbox that cannot be applied refuses the start, and says why in words
  it('SANDBOX_UNAVAILABLE codes become words', () => {
    const raw = (code: string): string => `Error invoking remote method 'sessions.spawn': Error: SANDBOX_UNAVAILABLE: ${code}`
    expect(spawnErrorMessage(raw('windows-setup codex acc_7f3'))).toEqual({ key: 'session.spawn.sandbox.windowsSetup', params: { accountId: 'acc_7f3' } })
    expect(spawnErrorMessage(raw('codex-daemon codex'))).toEqual({ key: 'session.spawn.sandbox.codexDaemon' })
    expect(spawnErrorMessage(raw('path-unsafe'))).toEqual({ key: 'session.spawn.sandbox.pathUnsafe' })
    // Task E fix round 3: a path the sandbox names other than the work folder (Astera's own, a login folder) has its own words
    expect(spawnErrorMessage(raw('named-path-unsafe'))).toEqual({ key: 'session.spawn.sandbox.namedPathUnsafe' })
    // Task E fix round 5: a named path through a link inside the work folder, where nothing else refuses it
    expect(spawnErrorMessage(raw('linked-path'))).toEqual({ key: 'session.spawn.sandbox.linkedPath' })
    expect(spawnErrorMessage(raw('git-layout'))).toEqual({ key: 'session.spawn.sandbox.gitLayout' })
    expect(spawnErrorMessage(raw('not-prepared'))).toEqual({ key: 'session.spawn.sandbox.notPrepared' })
    expect(spawnErrorMessage(raw('cli-too-old claude 2.1.300 2.1.306'))).toEqual({
      key: 'session.spawn.sandbox.cliTooOld',
      params: { cli: 'Claude Code', found: '2.1.300', min: '2.1.306' }
    })
    // The Host's own error, through `astera` or a Host-made session, and a code this build has no words for
    expect(spawnErrorMessage('SANDBOX_UNAVAILABLE: windows-setup codex acc_1')).toMatchObject({ key: 'session.spawn.sandbox.windowsSetup' })
    expect(spawnErrorMessage(raw('something-new'))).toEqual({ key: 'worktree.error.raw', params: { detail: raw('something-new') } })
    // Only a refusal that names an account offers the setup, for that account
    expect(sandboxSetupAccountOf(raw('windows-setup codex acc_7f3'))).toBe('acc_7f3')
    expect(sandboxSetupAccountOf(raw('path-unsafe'))).toBeNull()
    expect(sandboxSetupAccountOf('ENFORCE_UNAVAILABLE: codex-daemon')).toBeNull()
    // Task 6 fix round 1: Codex could not be asked. Its own words, and no setup offered: setting up would not help
    expect(spawnErrorMessage(raw('windows-check-failed codex acc_7f3'))).toEqual({ key: 'session.spawn.sandbox.windowsCheckFailed' })
    expect(sandboxSetupAccountOf(raw('windows-check-failed codex acc_7f3'))).toBeNull()
    // Task 7 fix round 1: a Claude whose version cannot be read or that is not there, and settings that could not be
    // written, each in its own words
    expect(spawnErrorMessage(raw('cli-version-unknown claude'))).toEqual({ key: 'session.spawn.sandbox.cliVersionUnknown', params: { cli: 'Claude Code' } })
    expect(spawnErrorMessage(raw('cli-missing claude'))).toEqual({ key: 'session.spawn.sandbox.cliMissing', params: { cli: 'Claude Code' } })
    expect(spawnErrorMessage(raw('settings-write-failed'))).toEqual({ key: 'session.spawn.sandbox.settingsWriteFailed' })
    expect(sandboxSetupAccountOf(raw('cli-missing claude'))).toBeNull()
  })

  // Task 6 fix round 1: the account id is an id's characters only, whatever quoting or JSON the error was carried in
  it('reads the account id out of quotes and JSON around the refusal', () => {
    expect(sandboxSetupAccountOf('{"error":"SANDBOX_UNAVAILABLE: windows-setup codex acc_7f3-x"}')).toBe('acc_7f3-x')
    expect(sandboxSetupAccountOf("Error: 'SANDBOX_UNAVAILABLE: windows-setup codex acc_1'.")).toBe('acc_1')
    expect(spawnErrorMessage('{"error":"SANDBOX_UNAVAILABLE: windows-setup codex acc_2"}')).toEqual({
      key: 'session.spawn.sandbox.windowsSetup',
      params: { accountId: 'acc_2' }
    })
  })

  // After 설정하기: the toast says it was set up, or shows what Codex said, on one line
  it('a setup that worked says so, and one that did not shows Codex’s output in one line', () => {
    expect(sandboxSetupOutcome({ ok: true, body: { ok: true, out: 'done' } })).toEqual({ ok: true })
    expect(sandboxSetupOutcome({ ok: true, body: { ok: false, out: 'Error: the elevation\r\n  was cancelled\n' } })).toEqual({
      ok: false,
      line: 'Error: the elevation was cancelled'
    })
    // The Host could not be asked, or refused: its sentence
    expect(sandboxSetupOutcome({ ok: false, code: 'HOST_NOT_RUNNING', message: 'the Host is not running' })).toEqual({ ok: false, line: 'the Host is not running' })
    const long = sandboxSetupOutcome({ ok: true, body: { ok: false, out: 'x'.repeat(1000) } })
    expect(long.ok === false && long.line?.length).toBe(300)
    // Codex said nothing: no line of its own, so the toast says it in the app's words (session.spawn.sandbox.setUpFailed)
    expect(sandboxSetupOutcome({ ok: true, body: { ok: false, out: '' } })).toEqual({ ok: false, line: null })
    expect(sandboxSetupOutcome({ ok: true, body: { ok: false, out: ' \n ' } })).toEqual({ ok: false, line: null })
  })

  it('응답하지 않는 폴더(CWD_UNREACHABLE)도 경로와 함께 말한다', () => {
    expect(spawnErrorMessage('Error: CWD_UNREACHABLE: folder not reachable: \\\\nas\\share')).toEqual({
      key: 'session.spawn.cwdUnreachable',
      params: { path: '\\\\nas\\share' }
    })
  })

  // 2026-10-07: a conversation sent to the Claude background closed its tab with exit 1 on resume.
  it('says a Claude background session holds the conversation, and whether it is working', () => {
    expect(
      spawnErrorMessage("Error invoking remote method 'sessions.spawn': Error: CLAUDE_IN_BACKGROUND: busy")
    ).toEqual({ key: 'session.spawn.inBackgroundBusy' })
    expect(spawnErrorMessage('Error: CLAUDE_IN_BACKGROUND: idle')).toEqual({ key: 'session.spawn.inBackground' })
  })

  it('그 밖의 오류는 worktree 오류 해석에 맡긴다', () => {
    expect(spawnErrorMessage("Error invoking remote method 'worktrees.create': Error: NO_BASE: x")).toEqual({
      key: 'worktree.error.noBase'
    })
  })
})
