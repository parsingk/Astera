import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AppSettingsStore } from './appSettingsStore'
import type { DesktopNotifySettings } from '../core/notify/settings'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-app-settings-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const file = (): string => path.join(dir, 'app-settings.json')

describe('AppSettingsStore', () => {
  it('파일이 없으면 lang은 null이다 (사용자가 고른 적 없음)', async () => {
    const store = new AppSettingsStore(file())
    expect(await store.load()).toEqual({ recovered: false })
    expect(store.getLang()).toBeNull()
  })

  it('저장한 언어를 다시 로드한다', async () => {
    const a = new AppSettingsStore(file())
    await a.load()
    await a.setLang('en')
    const b = new AppSettingsStore(file())
    await b.load()
    expect(b.getLang()).toBe('en')
  })

  it('setLang은 즉시 getLang에 반영된다', async () => {
    const store = new AppSettingsStore(file())
    await store.load()
    await store.setLang('ko')
    expect(store.getLang()).toBe('ko')
  })

  it('손상 파일은 .bak으로 보존하고 null로 기동한다', async () => {
    await fs.writeFile(file(), '{ not json', 'utf8')
    const store = new AppSettingsStore(file())
    expect(await store.load()).toEqual({ recovered: true })
    expect(store.getLang()).toBeNull()
    expect(await fs.readFile(file() + '.bak', 'utf8')).toBe('{ not json')
  })

  it('배열 JSON ([1,2]) → 손상 취급(null + .bak)', async () => {
    await fs.writeFile(file(), '[1,2]', 'utf8')
    const store = new AppSettingsStore(file())
    expect(await store.load()).toEqual({ recovered: true })
    expect(store.getLang()).toBeNull()
    expect(await fs.readFile(file() + '.bak', 'utf8')).toBe('[1,2]')
  })

  it('lang이 지원 언어가 아니면 무시한다', async () => {
    await fs.writeFile(file(), JSON.stringify({ lang: 'fr' }), 'utf8')
    const store = new AppSettingsStore(file())
    await store.load()
    expect(store.getLang()).toBeNull()
  })

  it('디렉토리가 없어도 저장한다', async () => {
    const nested = path.join(dir, 'sub', 'app-settings.json')
    const store = new AppSettingsStore(nested)
    await store.load()
    await store.setLang('en')
    // persist는 falsy 값을 생략한다(정해진 관례) — load가 `=== true`로 읽으므로
    // orchestrationEnabled:false를 파일에 남기지 않아도 결과가 같다
    expect(JSON.parse(await fs.readFile(nested, 'utf8'))).toEqual({ lang: 'en' })
  })
})

describe('lang — System은 null이다', () => {
  it('저장한 적 없으면 null', async () => {
    const store = new AppSettingsStore(file())
    await store.load()
    expect(store.getLang()).toBeNull()
  })
  it('언어를 고르면 그 값이 남는다', async () => {
    const f = file()
    const a = new AppSettingsStore(f)
    await a.load()
    await a.setLang('ja')
    const b = new AppSettingsStore(f)
    await b.load()
    expect(b.getLang()).toBe('ja')
  })
  it('null을 저장하면 System으로 되돌아간다', async () => {
    const f = file()
    const a = new AppSettingsStore(f)
    await a.load()
    await a.setLang('es')
    await a.setLang(null)
    const b = new AppSettingsStore(f)
    await b.load()
    expect(b.getLang()).toBeNull()
  })
})

describe('orchestrationEnabled', () => {
  it('기본값은 false다', async () => {
    const store = new AppSettingsStore(file())
    await store.load()
    expect(store.getOrchestrationEnabled()).toBe(false)
  })

  it('설정하고 새 인스턴스가 다시 읽는다', async () => {
    const a = new AppSettingsStore(file())
    await a.load()
    await a.setOrchestrationEnabled(true)
    const b = new AppSettingsStore(file())
    await b.load()
    expect(b.getOrchestrationEnabled()).toBe(true)
  })

  it('lang과 함께 저장돼도 서로를 지우지 않는다', async () => {
    const store = new AppSettingsStore(file())
    await store.load()
    await store.setLang('en')
    await store.setOrchestrationEnabled(true)
    const b = new AppSettingsStore(file())
    await b.load()
    expect(b.getLang()).toBe('en')
    expect(b.getOrchestrationEnabled()).toBe(true)
  })

  it('불리언이 아닌 값은 false로 떨어진다', async () => {
    await fs.writeFile(file(), JSON.stringify({ orchestrationEnabled: 'yes' }), 'utf8')
    const store = new AppSettingsStore(file())
    await store.load()
    expect(store.getOrchestrationEnabled()).toBe(false)
  })

  it('손상 파일 복구 뒤에는 false로 기동한다 — 이전 인스턴스 값이 남지 않는다', async () => {
    const a = new AppSettingsStore(file())
    await a.load()
    await a.setOrchestrationEnabled(true)
    await fs.writeFile(file(), '{ not json', 'utf8')
    await a.load()
    expect(a.getOrchestrationEnabled()).toBe(false)
  })

  it('파일이 없으면(ENOENT) false로 기동한다', async () => {
    const a = new AppSettingsStore(file())
    await a.load()
    await a.setOrchestrationEnabled(true)
    await fs.rm(file())
    await a.load()
    expect(a.getOrchestrationEnabled()).toBe(false)
  })
})

describe('githubPolling', () => {
  it('githubPolling defaults to on', async () => {
    const store = new AppSettingsStore(file())
    await store.load()
    expect(store.getGithubPolling()).toBe(true)
  })

  it('only an explicit false turns githubPolling off, and it persists', async () => {
    const a = new AppSettingsStore(file())
    await a.load()
    await a.setGithubPolling(false)
    const b = new AppSettingsStore(file())
    await b.load()
    expect(b.getGithubPolling()).toBe(false)
  })

  it('a corrupt file resets githubPolling to on', async () => {
    await fs.writeFile(file(), '{ not json', 'utf8')
    const store = new AppSettingsStore(file())
    await store.load()
    expect(store.getGithubPolling()).toBe(true)
  })
})

describe('resumeStrategy', () => {
  it('기본값은 original이다', async () => {
    const store = new AppSettingsStore(file())
    await store.load()
    expect(store.getResumeStrategy()).toBe('original')
  })

  it('smart를 저장하고 새 인스턴스가 다시 읽는다', async () => {
    const a = new AppSettingsStore(file())
    await a.load()
    await a.setResumeStrategy('smart')
    const b = new AppSettingsStore(file())
    await b.load()
    expect(b.getResumeStrategy()).toBe('smart')
  })

  it('알 수 없는 값은 original로 떨어진다', async () => {
    for (const raw of [{ resumeStrategy: 'ask' }, { resumeStrategy: 42 }, { resumeStrategy: null }]) {
      await fs.writeFile(file(), JSON.stringify(raw), 'utf8')
      const store = new AppSettingsStore(file())
      await store.load()
      expect(store.getResumeStrategy()).toBe('original')
    }
  })

  it('original일 때는 파일에 그 키를 쓰지 않는다', async () => {
    const store = new AppSettingsStore(file())
    await store.load()
    await store.setResumeStrategy('original')
    expect(JSON.parse(await fs.readFile(file(), 'utf8'))).not.toHaveProperty('resumeStrategy')
  })
})

describe('닫은 업데이트 캠페인 id', () => {
  it('없으면 null이다', async () => {
    const store = new AppSettingsStore(file())
    await store.load()
    expect(store.getDismissedCampaignId()).toBeNull()
  })

  it('저장한 id를 다시 로드한다', async () => {
    const a = new AppSettingsStore(file())
    await a.load()
    await a.setDismissedCampaignId('upgrade-0.3.9')
    const b = new AppSettingsStore(file())
    await b.load()
    expect(b.getDismissedCampaignId()).toBe('upgrade-0.3.9')
  })

  it('문자열이 아니거나 비면 무시한다', async () => {
    for (const raw of ['{"dismissedCampaignId":42}', '{"dismissedCampaignId":"  "}']) {
      await fs.writeFile(file(), raw, 'utf8')
      const store = new AppSettingsStore(file())
      await store.load()
      expect(store.getDismissedCampaignId()).toBeNull()
    }
  })

  it('두 필드가 서로를 지우지 않는다 — 예전 setLang은 {lang}만 써서 다른 필드를 날렸다', async () => {
    const store = new AppSettingsStore(file())
    await store.load()
    await store.setLang('en')
    await store.setDismissedCampaignId('c1')
    expect(JSON.parse(await fs.readFile(file(), 'utf8'))).toEqual({
      lang: 'en',
      dismissedCampaignId: 'c1'
    })
    // 반대 순서도 — 캠페인을 닫은 뒤 언어를 바꿔도 닫은 기록이 남아야 한다
    await store.setLang('ko')
    const reloaded = new AppSettingsStore(file())
    await reloaded.load()
    expect(reloaded.getLang()).toBe('ko')
    expect(reloaded.getDismissedCampaignId()).toBe('c1')
  })
})

describe('terminalFont', () => {
  it('defaults to both unset', async () => {
    const store = new AppSettingsStore(file())
    await store.load()
    expect(store.getTerminalFont()).toEqual({ latin: null, hangul: null })
  })

  it('round-trips through disk', async () => {
    const filePath = file()
    const a = new AppSettingsStore(filePath)
    await a.load()
    await a.setTerminalFont({ latin: 'Fira Code', hangul: 'D2Coding' })
    const b = new AppSettingsStore(filePath)
    await b.load()
    expect(b.getTerminalFont()).toEqual({ latin: 'Fira Code', hangul: 'D2Coding' })
  })

  it('drops a name that does not survive sanitising, on write and on read', async () => {
    const filePath = file()
    const a = new AppSettingsStore(filePath)
    await a.load()
    await a.setTerminalFont({ latin: 'Foo"; color:red', hangul: 'D2Coding' })
    expect(a.getTerminalFont()).toEqual({ latin: null, hangul: 'D2Coding' })

    await fs.writeFile(filePath, JSON.stringify({ terminalFont: { latin: 42, hangul: 'D2Coding' } }))
    const b = new AppSettingsStore(filePath)
    await b.load()
    expect(b.getTerminalFont()).toEqual({ latin: null, hangul: 'D2Coding' })
  })

  it('is cleared by corrupt-file recovery, like the other fields', async () => {
    const filePath = file()
    const store = new AppSettingsStore(filePath)
    await store.load()
    await store.setTerminalFont({ latin: 'Fira Code', hangul: null })
    await fs.writeFile(filePath, 'not json')
    expect((await store.load()).recovered).toBe(true)
    expect(store.getTerminalFont()).toEqual({ latin: null, hangul: null })
  })
})

describe('theme', () => {
  it('아무것도 저장하지 않았으면 기본은 umbra', async () => {
    const store = new AppSettingsStore(file())
    await store.load()
    expect(store.getTheme()).toBe('umbra')
  })

  // 기본값이 아닌 테마로 왕복시킨다 — 기본값을 쓰면 파일에 키가 없어도(생략 규칙) 통과해 버려서
  // 저장이 실제로 됐는지 확인하지 못한다.
  it('저장하고 다시 읽으면 유지된다', async () => {
    const filePath = file()
    const store = new AppSettingsStore(filePath)
    await store.load()
    await store.setTheme('vega')

    const again = new AppSettingsStore(filePath)
    await again.load()
    expect(again.getTheme()).toBe('vega')
  })

  it('파일에 든 알 수 없는 테마 이름은 기본값으로 떨어진다', async () => {
    // 사람이 손으로 고칠 수 있는 파일이다. 구버전에서 지운 테마 이름이 남아 있을 수도 있다.
    const filePath = file()
    await fs.writeFile(filePath, JSON.stringify({ theme: 'darcula' }), 'utf8')
    const store = new AppSettingsStore(filePath)
    await store.load()
    expect(store.getTheme()).toBe('umbra')
  })

  it('기본 테마는 파일에 쓰지 않는다 — 다른 필드의 falsy 생략 관례와 같다', async () => {
    const filePath = file()
    const store = new AppSettingsStore(filePath)
    await store.load()
    await store.setTheme('umbra')
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).not.toHaveProperty('theme')
  })

  it('테마를 저장해도 터미널 폰트가 지워지지 않는다', async () => {
    // persist() 가 항상 전체 객체를 쓰는 이유가 이것이다(그 주석이 기록한 과거 결함)
    const filePath = file()
    const store = new AppSettingsStore(filePath)
    await store.load()
    await store.setTerminalFont({ latin: 'Consolas', hangul: null })
    await store.setTheme('quasar')

    const again = new AppSettingsStore(filePath)
    await again.load()
    expect(again.getTerminalFont()).toEqual({ latin: 'Consolas', hangul: null })
    expect(again.getTheme()).toBe('quasar')
  })
})

describe('AppSettingsStore desktop notifications', () => {
  it('defaults: the two stopped-work events on, the two progress events off', async () => {
    const s = new AppSettingsStore(file())
    await s.load()
    expect(s.getDesktopNotify()).toEqual({
      inputNeeded: true,
      limitWaiting: true,
      accountSwitched: false,
      turnDone: false
    })
  })

  it('stores and reloads all four', async () => {
    const f = file()
    const a = new AppSettingsStore(f)
    await a.load()
    await a.setDesktopNotify({
      inputNeeded: false,
      limitWaiting: true,
      accountSwitched: true,
      turnDone: false
    })

    const b = new AppSettingsStore(f)
    await b.load()
    expect(b.getDesktopNotify()).toEqual({
      inputNeeded: false,
      limitWaiting: true,
      accountSwitched: true,
      turnDone: false
    })
  })

  // The file is user-editable, so the narrowing is per default: a default-on flag reads as off only
  // on an explicit false (as githubPolling does), a default-off flag reads as on only on an explicit
  // true. 'yes' and 1 must not turn anything on or off.
  it('narrows each flag against its own default', async () => {
    const f = file()
    await fs.writeFile(
      f,
      JSON.stringify({
        desktopNotify: { inputNeeded: 'no', limitWaiting: 0, accountSwitched: 'yes', turnDone: 1 }
      }),
      'utf8'
    )
    const s = new AppSettingsStore(f)
    await s.load()
    expect(s.getDesktopNotify()).toEqual({
      inputNeeded: true, // not an explicit false
      limitWaiting: true, // not an explicit false
      accountSwitched: false, // not an explicit true
      turnDone: false // not an explicit true
    })
  })

  // This is the boundary the renderer writes through. Before the fix, setDesktopNotify narrowed
  // every field with a uniform `=== true`, so a malformed value on a default-on flag (not an
  // explicit false) was written as false — silently disabling an "input needed" or
  // "limit waiting" notification, the one direction this feature must never fail in.
  it("setDesktopNotify narrows malformed input against each flag's own default, not to false", async () => {
    const f = file()
    const s = new AppSettingsStore(f)
    await s.load()
    await s.setDesktopNotify({
      inputNeeded: 'no',
      limitWaiting: 0,
      accountSwitched: 'yes',
      turnDone: 1
    } as unknown as DesktopNotifySettings)
    expect(s.getDesktopNotify()).toEqual({
      inputNeeded: true, // not an explicit false
      limitWaiting: true, // not an explicit false
      accountSwitched: false, // not an explicit true
      turnDone: false // not an explicit true
    })
  })

  it('a non-object desktopNotify is the defaults', async () => {
    for (const raw of ['[]', '"on"', 'null', '3']) {
      const f = file()
      await fs.writeFile(f, `{"desktopNotify": ${raw}}`, 'utf8')
      const s = new AppSettingsStore(f)
      await s.load()
      expect(s.getDesktopNotify()).toEqual({
        inputNeeded: true,
        limitWaiting: true,
        accountSwitched: false,
        turnDone: false
      })
    }
  })

  // The corrupt-file recovery must reset these too — otherwise, on a reload through the same
  // instance, a previous value survives and leaves a setting the file does not contain.
  it('a corrupt file recovers to the defaults, not to the previous values', async () => {
    const f = file()
    const s = new AppSettingsStore(f)
    await s.load()
    await s.setDesktopNotify({
      inputNeeded: false,
      limitWaiting: false,
      accountSwitched: true,
      turnDone: true
    })
    await fs.writeFile(f, '{ not json', 'utf8')
    const r = await s.load()
    expect(r.recovered).toBe(true)
    expect(s.getDesktopNotify()).toEqual({
      inputNeeded: true,
      limitWaiting: true,
      accountSwitched: false,
      turnDone: false
    })
  })

  it('the key is omitted from the file while every flag is at its default', async () => {
    const f = file()
    const s = new AppSettingsStore(f)
    await s.load()
    await s.setDesktopNotify({
      inputNeeded: true,
      limitWaiting: true,
      accountSwitched: false,
      turnDone: false
    })
    const parsed = JSON.parse(await fs.readFile(f, 'utf8')) as Record<string, unknown>
    expect(parsed.desktopNotify).toBeUndefined()
  })
})
