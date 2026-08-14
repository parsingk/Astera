import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RunConfigStore } from './runConfigStore'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-runcfg-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('RunConfigStore', () => {
  it('프로젝트별 구성을 저장·조회하고 파일로 영속한다', async () => {
    const file = path.join(dir, 'run.json')
    const store = new RunConfigStore(file)
    await store.load()
    expect(store.get('D:/proj')).toEqual([])
    await store.save('D:/proj', [{ id: 'u1', name: '내 dev', type: 'shell', command: 'pnpm run dev' }])
    // 새 인스턴스가 파일에서 다시 읽어도 남아 있어야 한다
    const store2 = new RunConfigStore(file)
    await store2.load()
    expect(store2.get('D:/proj')).toEqual([
      { id: 'u1', name: '내 dev', type: 'shell', command: 'pnpm run dev' }
    ])
  })
  it('손상 파일은 빈 상태로 복구한다', async () => {
    const file = path.join(dir, 'run.json')
    await fs.writeFile(file, '{ broken', 'utf8')
    const store = new RunConfigStore(file)
    const r = await store.load()
    expect(r.recovered).toBe(true)
    expect(store.get('x')).toEqual([])
  })

  // 읽기와 쓰기는 같은 관문을 지나야 한다. ＋ 는 종류를 고르는 순간 구성을 저장하는데, 그때 그
  // 종류의 필수 필드는 아직 비어 있다 — 읽기만 엄격하면 앱이 자기가 쓴 파일을 못 읽어, 다음 실행에서
  // 그 구성이 말없이 사라진다. 느슨해지는 것은 "비었다" 하나뿐이라는 것도 함께 건다
  describe('아직 덜 채운 구성', () => {
    const write = (file: string, configs: unknown): Promise<void> =>
      fs.writeFile(file, JSON.stringify({ 'D:/proj': configs }), 'utf8')

    it('필수 필드가 빈 구성도 다시 읽어 온다 — 저장이 허용한 것은 읽기도 허용한다', async () => {
      const file = path.join(dir, 'run.json')
      const configs = [
        { id: 'u1', name: 'Node.js', type: 'node', file: '' },
        { id: 'u2', name: 'Dockerfile', type: 'dockerfile', imageTag: '' }
      ]
      await write(file, configs)
      const store = new RunConfigStore(file)
      const r = await store.load()
      expect(r.recovered).toBe(false)
      expect(store.get('D:/proj')).toEqual(configs)
    })

    it('그래도 필수 필드가 아예 없거나 문자열이 아니면 그 항목만 버린다', async () => {
      const file = path.join(dir, 'run.json')
      await write(file, [
        { id: 'u1', name: 'no field', type: 'node' },
        { id: 'u2', name: 'wrong type', type: 'node', file: 3 },
        { id: 'u3', name: 'ok', type: 'node', file: '' }
      ])
      const store = new RunConfigStore(file)
      const r = await store.load()
      expect(r.recovered).toBe(false)
      expect(store.get('D:/proj').map((c) => c.id)).toEqual(['u3'])
    })
  })

  describe('env 스키마 검증', () => {
    const write = (file: string, configs: unknown): Promise<void> =>
      fs.writeFile(file, JSON.stringify({ 'D:/proj': configs }), 'utf8')

    it('env 없는 기존 구성은 계속 유효하다', async () => {
      const file = path.join(dir, 'run.json')
      await write(file, [{ id: 'u1', name: '내 dev', command: 'pnpm run dev' }])
      const store = new RunConfigStore(file)
      const r = await store.load()
      expect(r.recovered).toBe(false)
      expect(store.get('D:/proj')).toEqual([
        { id: 'u1', name: '내 dev', type: 'shell', command: 'pnpm run dev' }
      ])
    })

    it('값이 모두 문자열인 env는 유효하다', async () => {
      const file = path.join(dir, 'run.json')
      const configs = [{ id: 'u1', name: 'boot', command: './gradlew bootRun', env: { JAVA_HOME: 'C:/jdk-21' } }]
      await write(file, configs)
      const store = new RunConfigStore(file)
      const r = await store.load()
      expect(r.recovered).toBe(false)
      expect(store.get('D:/proj')).toEqual([{ ...configs[0], type: 'shell' }])
    })

    // 손 편집한 항목 하나가 저장소 전체를 날리면 안 된다 — migrateRunConfigs 가 그 항목만 버린다
    it('env 값이 숫자인 항목만 버리고 나머지는 유지한다', async () => {
      const file = path.join(dir, 'run.json')
      await write(file, [
        { id: 'u1', name: 'boot', command: 'x', env: { PORT: 8080 } },
        { id: 'u2', name: 'ok', command: 'y' }
      ])
      const store = new RunConfigStore(file)
      const r = await store.load()
      expect(r.recovered).toBe(false)
      expect(store.get('D:/proj').map((c) => c.id)).toEqual(['u2'])
    })

    it('env 값이 객체인 항목만 버리고 나머지는 유지한다', async () => {
      const file = path.join(dir, 'run.json')
      await write(file, [
        { id: 'u1', name: 'boot', command: 'x', env: { NESTED: { a: 1 } } },
        { id: 'u2', name: 'ok', command: 'y' }
      ])
      const store = new RunConfigStore(file)
      const r = await store.load()
      expect(r.recovered).toBe(false)
      expect(store.get('D:/proj').map((c) => c.id)).toEqual(['u2'])
    })

    it('env 자체가 배열인 항목만 버리고 나머지는 유지한다', async () => {
      const file = path.join(dir, 'run.json')
      await write(file, [
        { id: 'u1', name: 'boot', command: 'x', env: ['A=1'] },
        { id: 'u2', name: 'ok', command: 'y' }
      ])
      const store = new RunConfigStore(file)
      const r = await store.load()
      expect(r.recovered).toBe(false)
      expect(store.get('D:/proj').map((c) => c.id)).toEqual(['u2'])
    })
  })

  describe('cwd 스키마 검증', () => {
    const write = (file: string, configs: unknown): Promise<void> =>
      fs.writeFile(file, JSON.stringify({ 'D:/proj': configs }), 'utf8')

    it('cwd 없는 구성은 유효하다 (선택 필드)', async () => {
      const file = path.join(dir, 'run.json')
      const configs = [{ id: 'u1', name: 'boot', command: './gradlew bootRun' }]
      await write(file, configs)
      const store = new RunConfigStore(file)
      const r = await store.load()
      expect(r.recovered).toBe(false)
      expect(store.get('D:/proj')).toEqual([{ ...configs[0], type: 'shell' }])
    })

    it('문자열 cwd는 유효하다 — 허용 루트 판정은 run.start가 실행 직전에 한다', async () => {
      const file = path.join(dir, 'run.json')
      const configs = [{ id: 'u1', name: 'api', command: 'mvnw.cmd spring-boot:run', cwd: 'services/api' }]
      await write(file, configs)
      const store = new RunConfigStore(file)
      const r = await store.load()
      expect(r.recovered).toBe(false)
      expect(store.get('D:/proj')).toEqual([{ ...configs[0], type: 'shell' }])
    })

    it('cwd가 문자열이 아닌 항목만 버리고 나머지는 유지한다', async () => {
      const file = path.join(dir, 'run.json')
      await write(file, [
        { id: 'u1', name: 'boot', command: 'x', cwd: 123 },
        { id: 'u2', name: 'ok', command: 'y' }
      ])
      const store = new RunConfigStore(file)
      const r = await store.load()
      expect(r.recovered).toBe(false)
      expect(store.get('D:/proj').map((c) => c.id)).toEqual(['u2'])
    })

    it('cwd가 객체인 항목만 버리고 나머지는 유지한다', async () => {
      const file = path.join(dir, 'run.json')
      await write(file, [
        { id: 'u1', name: 'boot', command: 'x', cwd: { path: 'D:/x' } },
        { id: 'u2', name: 'ok', command: 'y' }
      ])
      const store = new RunConfigStore(file)
      const r = await store.load()
      expect(r.recovered).toBe(false)
      expect(store.get('D:/proj').map((c) => c.id)).toEqual(['u2'])
    })
  })
})
