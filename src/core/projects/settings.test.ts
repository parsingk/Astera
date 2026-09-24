import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProjectSettings } from './settings'
import { absPath } from '../testPaths'

let tmp: string
let settings: ProjectSettings

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-projects-'))
  settings = new ProjectSettings(path.join(tmp, 'projects.json'))
  await settings.load()
})

describe('ProjectSettings', () => {
  it('설정 없는 프로젝트는 null', () => {
    expect(settings.getDefaultAccount('D:\\some\\proj')).toBeNull()
  })

  it('set 후 get, 대소문자 무시(win32)', async () => {
    const s = new ProjectSettings(path.join(tmp, 'win.json'), 'win32')
    await s.load()
    await s.setDefaultAccount(absPath('Some', 'Proj'), 'acc-1')
    expect(s.getDefaultAccount(absPath('some', 'proj'))).toBe('acc-1')
  })

  it('linux 에서는 대소문자만 다른 두 폴더가 서로 다른 설정을 갖는다', async () => {
    const s = new ProjectSettings(path.join(tmp, 'linux.json'), 'linux')
    await s.load()
    await s.setDefaultAccount(absPath('home', 'u', 'Proj'), 'acc-1')
    expect(s.getDefaultAccount(absPath('home', 'u', 'proj'))).toBeNull()
  })

  it('linux: 예전 빌드가 소문자로 적은 키를 찾고, 다시 쓸 때는 원래 철자로 적는다', async () => {
    const file = path.join(tmp, 'legacy.json')
    const exact = path.resolve(absPath('home', 'u', 'Proj'))
    const legacy = exact.toLowerCase()
    await fs.writeFile(file, JSON.stringify({ [legacy]: 'acc-old' }), 'utf8')
    const s = new ProjectSettings(file, 'linux')
    await s.load()
    expect(s.getDefaultAccount(exact)).toBe('acc-old')
    await s.setDefaultAccount(exact, 'acc-new')
    // 옛 키는 지우지 않는다 — linux 에서는 그것이 이제 진짜 소문자 폴더의 키일 수 있다
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ [legacy]: 'acc-old', [exact]: 'acc-new' })
    expect(s.getDefaultAccount(exact)).toBe('acc-new')
    await s.setDefaultAccount(exact, null)
    // 지운 뒤에 옛 키가 남아 되살아나면 안 된다
    expect(s.getDefaultAccount(exact)).toBeNull()
  })

  it('null로 설정하면 제거된다', async () => {
    await settings.setDefaultAccount('D:\\p', 'acc-1')
    await settings.setDefaultAccount('D:\\p', null)
    expect(settings.getDefaultAccount('D:\\p')).toBeNull()
  })

  it('재로드 후 유지된다', async () => {
    await settings.setDefaultAccount('D:\\p', 'acc-9')
    const again = new ProjectSettings(path.join(tmp, 'projects.json'))
    await again.load()
    expect(again.getDefaultAccount('D:\\p')).toBe('acc-9')
  })

  it('손상 JSON 파일 → load 후 빈 맵 + .bak 파일에 원본 보존', async () => {
    const filePath = path.join(tmp, 'corrupt.json')
    await fs.writeFile(filePath, '{invalid json', 'utf8')
    const s = new ProjectSettings(filePath)
    const result = await s.load()
    expect(result.recovered).toBe(true)
    expect(s.getDefaultAccount('D:\\any')).toBeNull()
    const bakContent = await fs.readFile(filePath + '.bak', 'utf8')
    expect(bakContent).toBe('{invalid json')
  })

  it('배열 JSON ([1,2]) → 손상 취급(빈 맵 + .bak)', async () => {
    const filePath = path.join(tmp, 'array.json')
    await fs.writeFile(filePath, '[1,2]', 'utf8')
    const s = new ProjectSettings(filePath)
    const result = await s.load()
    expect(result.recovered).toBe(true)
    expect(s.getDefaultAccount('D:\\any')).toBeNull()
    const bakContent = await fs.readFile(filePath + '.bak', 'utf8')
    expect(bakContent).toBe('[1,2]')
  })
})
