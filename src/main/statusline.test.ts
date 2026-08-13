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

  it('spawnConfig: hooks=true면 hooks 설정 파일 + 세션별 hookOutPath', () => {
    const c = mgr.spawnConfig('sess-1', account, { hooks: true })
    expect(c.settingsFile).toContain('astera-hooks-settings.json')
    expect(c.hookOutPath?.replace(/\\/g, '/')).toContain('hook-events/sess-1.jsonl')
  })

  it('spawnConfig: hooks 미지정이면 기존 설정 파일, hookOutPath 없음', () => {
    const c = mgr.spawnConfig('sess-1', account)
    expect(c.settingsFile).toContain('astera-statusline-settings.json')
    expect(c.hookOutPath).toBeUndefined()
  })

  it('기존 statusLine 설정 파일은 hooks 없이 그대로 만든다 (회귀 가드)', async () => {
    const settings = JSON.parse(await fs.readFile(path.join(dir, 'astera-statusline-settings.json'), 'utf8'))
    expect(settings.statusLine.command).toContain('astera-statusline-capture.cjs')
    expect(settings.hooks).toBeUndefined()
  })
})
