import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProjectSettings } from './settings'

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
    await settings.setDefaultAccount('D:\\Some\\Proj', 'acc-1')
    expect(settings.getDefaultAccount('d:\\some\\proj')).toBe('acc-1')
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
