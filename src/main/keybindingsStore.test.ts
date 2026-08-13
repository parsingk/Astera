import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { KeybindingsStore } from './keybindingsStore'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-keybindings-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const file = (): string => path.join(dir, 'keybindings.json')

describe('KeybindingsStore', () => {
  it('파일이 없으면 덮어쓰기 없음(=전부 기본값)', async () => {
    const store = new KeybindingsStore(file())
    expect(await store.load()).toEqual({ recovered: false })
    expect(store.get()).toEqual({})
  })

  it('저장한 바인딩을 다시 로드한다', async () => {
    const a = new KeybindingsStore(file())
    await a.load()
    await a.set('explorer.toggleMode', ['Ctrl+`'])
    const b = new KeybindingsStore(file())
    await b.load()
    expect(b.get()).toEqual({ 'explorer.toggleMode': ['Ctrl+`'] })
  })

  it('여러 액션을 각각 덮어쓴다', async () => {
    const store = new KeybindingsStore(file())
    await store.load()
    await store.set('explorer.toggleMode', ['F4'])
    await store.set('sessionTab.next', ['Ctrl+Shift+]'])
    expect(store.get()).toEqual({
      'explorer.toggleMode': ['F4'],
      'sessionTab.next': ['Ctrl+Shift+]']
    })
  })

  it('빈 배열도 저장한다 — 액션을 끄는 의미다', async () => {
    const store = new KeybindingsStore(file())
    await store.load()
    await store.set('explorer.closeFileTab', [])
    expect(store.get()).toEqual({ 'explorer.closeFileTab': [] })
  })

  it('reset(actionId)는 그 액션만 기본값으로 되돌린다', async () => {
    const store = new KeybindingsStore(file())
    await store.load()
    await store.set('explorer.toggleMode', ['F4'])
    await store.set('sessionTab.next', ['F5'])
    await store.reset('explorer.toggleMode')
    expect(store.get()).toEqual({ 'sessionTab.next': ['F5'] })
  })

  it('reset()은 전부 되돌린다', async () => {
    const store = new KeybindingsStore(file())
    await store.load()
    await store.set('explorer.toggleMode', ['F4'])
    await store.reset()
    expect(store.get()).toEqual({})
    const reloaded = new KeybindingsStore(file())
    await reloaded.load()
    expect(reloaded.get()).toEqual({})
  })

  it('손상 파일은 .bak으로 보존하고 기본값으로 기동한다', async () => {
    await fs.writeFile(file(), '{ not json', 'utf8')
    const store = new KeybindingsStore(file())
    expect(await store.load()).toEqual({ recovered: true })
    expect(store.get()).toEqual({})
    expect(await fs.readFile(file() + '.bak', 'utf8')).toBe('{ not json')
  })

  it('배열 JSON도 손상 취급', async () => {
    await fs.writeFile(file(), '["Ctrl+E"]', 'utf8')
    const store = new KeybindingsStore(file())
    expect(await store.load()).toEqual({ recovered: true })
    expect(store.get()).toEqual({})
  })

  it('값이 문자열 배열이 아닌 항목은 버린다 — 파일 전체를 버리지는 않는다', async () => {
    await fs.writeFile(
      file(),
      JSON.stringify({
        'explorer.toggleMode': ['F4'],
        'sessionTab.next': 'Ctrl+Tab',
        'pane.splitRight': [1, 2],
        'pane.splitDown': null
      }),
      'utf8'
    )
    const store = new KeybindingsStore(file())
    expect(await store.load()).toEqual({ recovered: false })
    expect(store.get()).toEqual({ 'explorer.toggleMode': ['F4'] })
  })
})
