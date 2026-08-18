import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readSeedTexts, loadRunConfigs, prepareRun } from './prepare'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-prepare-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** 실제 배선은 registerIpc 의 클로저를 넘기지만, 테스트에서는 통과시키기만 하면 된다 */
const allowAll = async (p: string): Promise<string> => p
/** 번역도 주입된다 — 테스트에서는 키를 그대로 돌려줘 메시지를 검사할 수 있게 한다 */
const rawT = (key: string): string => key

describe('readSeedTexts', () => {
  it('있는 파일만 읽고 없는 것은 null 이다', async () => {
    await fs.writeFile(path.join(dir, 'package.json'), '{"scripts":{"build":"tsc"}}', 'utf8')
    const texts = await readSeedTexts(dir, ['package.json'])
    expect(texts.packageJson).toContain('tsc')
    expect(texts.buildGradle).toBeNull()
    expect(texts.pom).toBeNull()
  })

  // .kts 와 .gradle 이 둘 다 있으면 .kts 가 이긴다 — 기존 주석이 명시하는 규칙이다
  it('build.gradle.kts 가 build.gradle 보다 우선한다', async () => {
    await fs.writeFile(path.join(dir, 'build.gradle.kts'), 'kts', 'utf8')
    await fs.writeFile(path.join(dir, 'build.gradle'), 'groovy', 'utf8')
    const texts = await readSeedTexts(dir, ['build.gradle.kts', 'build.gradle'])
    expect(texts.buildGradle).toBe('kts')
  })

  // 읽기 실패 하나가 run.list/run.start 전체를 무너뜨리면 안 된다
  it('목록에 있지만 읽을 수 없는 파일은 null 이 된다', async () => {
    const texts = await readSeedTexts(dir, ['package.json'])
    expect(texts.packageJson).toBeNull()
  })
})

describe('loadRunConfigs', () => {
  it('저장된 구성과 자동 감지된 시드를 합친다', async () => {
    await fs.writeFile(path.join(dir, 'package.json'), '{"scripts":{"build":"tsc"}}', 'utf8')
    const stored = [
      { id: 'c1', name: '내 구성', type: 'shell' as const, command: 'echo hi' }
    ]
    const r = await loadRunConfigs({ projectPath: dir, stored })
    expect(r.configs.some((c) => c.id === 'c1')).toBe(true)
    expect(r.configs.length).toBeGreaterThan(1) // 시드가 최소 하나 붙는다
    expect(r.files).toContain('package.json')
    expect(r.texts.packageJson).toContain('tsc')
  })

  it('읽을 수 없는 디렉터리면 파일 목록이 비고 저장된 구성만 남는다', async () => {
    const stored = [{ id: 'c1', name: '내 구성', type: 'shell' as const, command: 'echo hi' }]
    const r = await loadRunConfigs({ projectPath: path.join(dir, 'nope'), stored })
    expect(r.files).toEqual([])
    expect(r.configs.map((c) => c.id)).toEqual(['c1'])
  })
})

describe('prepareRun', () => {
  const shell = { id: 'c1', name: '내 구성', type: 'shell' as const, command: 'echo hi' }

  it('구성을 찾아 명령을 조립한다', async () => {
    const r = await prepareRun({
      projectPath: dir,
      configId: 'c1',
      stored: [shell],
      assertAllowedPath: allowAll,
      t: rawT
    })
    expect(r.config.id).toBe('c1')
    expect(r.command).toBe('echo hi')
    expect(r.projectName).toBe(path.basename(dir))
  })

  it('없는 id 는 NO_CONFIG 로 거절한다', async () => {
    await expect(
      prepareRun({ projectPath: dir, configId: 'nope', stored: [shell], assertAllowedPath: allowAll, t: rawT })
    ).rejects.toThrow('NO_CONFIG')
  })

  // 미완성 구성을 저장하는 것은 허용되지만 실행은 아니다 — 비어 있는 필드를 이름으로 알려 준다
  it('필수 필드가 비면 거절한다', async () => {
    const incomplete = { id: 'c2', name: '빈 구성', type: 'shell' as const, command: '' }
    await expect(
      prepareRun({ projectPath: dir, configId: 'c2', stored: [incomplete], assertAllowedPath: allowAll, t: rawT })
    ).rejects.toThrow('run.start.incomplete')
  })

  // 검증은 워커가 일한 트리에서 돌아야 하므로, 구성에 박힌 cwd 를 무시할 수단이 필요하다
  it('ignoreConfigCwd 면 구성의 cwd 를 버린다', async () => {
    const sub = path.join(dir, 'sub')
    await fs.mkdir(sub)
    const pinned = { ...shell, cwd: 'sub' }
    const kept = await prepareRun({
      projectPath: dir, configId: 'c1', stored: [pinned], assertAllowedPath: allowAll, t: rawT
    })
    expect(kept.config.cwd).toBe(sub)
    const dropped = await prepareRun({
      projectPath: dir, configId: 'c1', stored: [pinned], ignoreConfigCwd: true,
      assertAllowedPath: allowAll, t: rawT
    })
    expect(dropped.config.cwd).toBeUndefined()
  })

  it('프로젝트 밖을 가리키는 cwd 는 거절한다', async () => {
    const outside = { ...shell, cwd: '..' }
    await expect(
      prepareRun({ projectPath: dir, configId: 'c1', stored: [outside], assertAllowedPath: allowAll, t: rawT })
    ).rejects.toThrow('run.config.cwdOutsideProject')
  })
})
