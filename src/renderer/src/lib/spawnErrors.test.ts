import { describe, it, expect } from 'vitest'
import { spawnErrorMessage } from './spawnErrors'

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
    // The Host's own error, through `astera`
    expect(spawnErrorMessage('ENFORCE_UNAVAILABLE: cli-too-old codex 0.159.0 0.160.0')).toMatchObject({ params: { cli: 'Codex' } })
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
