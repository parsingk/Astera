import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProjectSettings } from './settings'
import { absPath } from '../testPaths'

let tmp: string

/** A resolved absolute path whose only upper case is the one in name. On win32 the drive letter is
 *  lower-cased too, so the lower spelling really is the all-lower-case key an older build would have
 *  written, and the linux rule is tested on the platform most runs happen on. */
const caseDir = (name: string): string => path.join(path.resolve(absPath('home', 'u')).toLowerCase(), name)
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

  // 반대 방향: 소문자 폴더의 설정은 그 폴더의 것이다. 대문자 형제가 소문자 키로 되짚으면 그 값을
  // 읽고, 형제를 지울 때 소문자 폴더 자신의 설정이 지워진다 — 다시 불러온 뒤에도 마찬가지다.
  it('linux: 이 빌드가 적은 소문자 폴더의 설정을 대문자 형제가 읽거나 지우지 않는다 (재로드 후에도)', async () => {
    const file = path.join(tmp, 'fresh.json')
    const lower = caseDir('proj')
    const upper = caseDir('Proj')
    const s = new ProjectSettings(file, 'linux')
    await s.load()
    await s.setDefaultAccount(lower, 'acc-y')
    expect(s.getDefaultAccount(upper)).toBeNull()
    await s.setDefaultAccount(upper, null)
    expect(s.getDefaultAccount(lower)).toBe('acc-y')

    const again = new ProjectSettings(file, 'linux')
    await again.load()
    expect(again.getDefaultAccount(upper)).toBeNull()
    await again.setDefaultAccount(upper, null)
    expect(again.getDefaultAccount(lower)).toBe('acc-y')
  })

  // 받아들인 대가를 고정한다: linux 에서는 예전 빌드가 소문자로 적은 키를 대문자가 든 경로로 찾지 않는다.
  // 새 세션 대화상자가 미리 고르는 계정을 한 번 잊을 뿐이고, 옛 항목은 파일에 그대로 남는다
  it('linux: 예전 빌드가 소문자로 적은 키는 대문자가 든 경로로 찾지 않는다 (옛 항목은 그대로 둔다)', async () => {
    const file = path.join(tmp, 'legacy.json')
    const upper = caseDir('Proj')
    const legacy = upper.toLowerCase()
    await fs.writeFile(file, JSON.stringify({ [legacy]: 'acc-old' }), 'utf8')
    const s = new ProjectSettings(file, 'linux')
    await s.load()
    expect(s.getDefaultAccount(upper)).toBeNull()
    await s.setDefaultAccount(upper, 'acc-new')
    await s.setDefaultAccount(upper, null)
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ [legacy]: 'acc-old' })
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
