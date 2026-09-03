import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Account } from '../core/types'
import { StatusLineManager } from './statusline'

const account: Account = {
  id: 'a1', label: 't', configDir: path.join(os.tmpdir(), 'astera-none-config'), color: '#fff',
  createdAt: '2026-07-23T00:00:00Z'
}

describe('StatusLineManager 훅 주입', () => {
  let dir: string
  let mgr: StatusLineManager

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-sl-'))
    mgr = new StatusLineManager(dir)
    await mgr.init()
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('init은 훅 캡처 스크립트·hooks 설정 파일·hook-events 디렉터리를 만든다', async () => {
    const capture = await fs.readFile(path.join(dir, 'astera-hook-capture.cjs'), 'utf8')
    expect(capture).toContain('ASTERA_HOOK_OUT')
    const settings = JSON.parse(await fs.readFile(path.join(dir, 'astera-hooks-settings.json'), 'utf8'))
    expect(settings.statusLine.type).toBe('command')
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('astera-hook-capture.cjs')
    expect(settings.hooks.Notification[0].hooks[0].command).toContain('astera-hook-capture.cjs')
    expect((await fs.stat(mgr.hookEventsDir)).isDirectory()).toBe(true)
  })

  // PreToolUse로 캡처한 대기 내용을 확정 무효화하는 짝이다 — 없으면 서브에이전트가 실행한 도구가
  // Stop 전까지 "대기 중"으로 남는다(사유는 SlackNotifier.clearPendingTool 주석).
  it('PostToolUse 훅도 PreToolUse와 같은 matcher로 등록한다', async () => {
    const settings = JSON.parse(await fs.readFile(path.join(dir, 'astera-hooks-settings.json'), 'utf8'))
    expect(settings.hooks.PostToolUse[0].matcher).toBe(settings.hooks.PreToolUse[0].matcher)
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain('astera-hook-capture.cjs')
  })

  it('spawnConfig: toolHooks=true면 도구 캡처까지 든 설정 파일', () => {
    const c = mgr.spawnConfig('sess-1', account, { toolHooks: true })
    expect(c.settingsFile).toContain('astera-hooks-settings.json')
    expect(c.hookOutPath?.replace(/\\/g, '/')).toContain('hook-events/sess-1.jsonl')
  })

  // 데스크톱 알림은 어떤 세션에서든 온다 — 그 세션에 Slack 을 켜 뒀는지, 롤링을 걸어 뒀는지와
  // 무관하다. 그러려면 Stop·Notification 훅이 모든 세션에 들어가야 하고, 그 훅이 쓸
  // ASTERA_HOOK_OUT 경로도 함께 있어야 한다. 이 경로가 없던 동안 훅은 심어져도 쓸 곳이 없었고,
  // 알림 기능 전체가 보통 세션에서 한 번도 동작하지 않았다.
  it('spawnConfig: 도구 캡처가 없어도 세션별 hookOutPath 는 항상 준다', () => {
    const c = mgr.spawnConfig('sess-1', account)
    expect(c.settingsFile).toContain('astera-statusline-settings.json')
    expect(c.hookOutPath?.replace(/\\/g, '/')).toContain('hook-events/sess-1.jsonl')
  })

  it('기본 설정 파일도 Stop·Notification 훅을 갖는다', async () => {
    const settings = JSON.parse(await fs.readFile(path.join(dir, 'astera-statusline-settings.json'), 'utf8'))
    expect(settings.statusLine.command).toContain('astera-statusline-capture.cjs')
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('astera-hook-capture.cjs')
    expect(settings.hooks.Notification[0].hooks[0].command).toContain('astera-hook-capture.cjs')
  })

  // 원래 회귀 가드가 지키려던 것은 "훅이 없다"가 아니라 "도구 호출마다 프로세스가 뜨지 않는다"
  // 였다. Stop 은 턴당 한 번, Notification 은 프롬프트가 뜰 때뿐이라 값이 싸다. 비싼 쪽은 도구
  // 짝이고, 그건 여전히 Slack·롤링 세션에만 들어간다.
  it('기본 설정 파일은 도구 훅을 갖지 않는다 (회귀 가드)', async () => {
    const settings = JSON.parse(await fs.readFile(path.join(dir, 'astera-statusline-settings.json'), 'utf8'))
    expect(settings.hooks.PreToolUse).toBeUndefined()
    expect(settings.hooks.PostToolUse).toBeUndefined()
  })
})
