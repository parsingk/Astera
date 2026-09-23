import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readRunConfigsFile } from './runConfigsFile'

let dir: string
let project: string
let file: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-runcfg-'))
  project = path.join(dir, 'proj')
  await fs.mkdir(project)
  await fs.writeFile(path.join(project, 'package.json'), '{"scripts":{"test":"vitest"}}', 'utf8')
  file = path.join(dir, 'run-configs.json')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const stored = (id: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name,
  type: 'shell',
  command: 'echo hi',
  env: {},
  ...extra
})

describe('readRunConfigsFile', () => {
  // 앱의 RunConfigStore 가 "구성을 저장한 적 없는 프로필" 로 읽는 것과 같다 — 빌드 파일의 시드만 남는다.
  it('파일이 없으면 폴더의 시드만이다', async () => {
    expect(await readRunConfigsFile(file, project)).toEqual([{ id: 'seed:npm:test', name: 'test', type: 'npm' }])
  })

  // 앱과 같은 열쇠(프로젝트 경로 그대로)로 찾는다. 다른 프로젝트의 것은 섞이지 않는다.
  it('그 프로젝트에 저장된 구성을 시드와 합치고, 셋만 낸다', async () => {
    await fs.writeFile(
      file,
      JSON.stringify({
        [project]: [stored('cfg_1', 'unit', { env: { TOKEN: 's3cret' }, cwd: 'sub' })],
        [path.join(dir, 'other')]: [stored('cfg_other', 'other')]
      }),
      'utf8'
    )
    const before = await fs.stat(file)
    const listed = await readRunConfigsFile(file, project)
    expect(listed).toEqual([
      { id: 'cfg_1', name: 'unit', type: 'shell' },
      { id: 'seed:npm:test', name: 'test', type: 'npm' }
    ])
    expect(JSON.stringify(listed)).not.toContain('s3cret')
    expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs)
  })

  // 앱은 읽을 수 없는 파일을 .bak 으로 옮기고 빈 채로 시작한다 — 그것은 쓰기이고, 이 읽기는 하지 않는다.
  // "구성이 없다" 로 답하지도 않는다: 그러면 --validate 의 id 가 전부 거짓 404 가 된다.
  it('깨진 파일은 고치지 않고 거절한다 — 앱을 열라고 말한다', async () => {
    for (const text of ['{not json', '[]']) {
      await fs.writeFile(file, text, 'utf8')
      await expect(readRunConfigsFile(file, project)).rejects.toThrow(/run-configs\.json .*open Astera to repair it/)
      expect(await fs.readFile(file, 'utf8')).toBe(text)
    }
    expect(await fs.readdir(dir)).not.toContain('run-configs.json.bak')
  })
})
