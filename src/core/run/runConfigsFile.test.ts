import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { allowingJobCwds, readRunConfigsFile } from './runConfigsFile'

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

// 앱이 열려 있을 때의 경계(phase D 수정 1회차). 앱의 assertAllowedPath 는 세션 cwd·워크트리·기록의
// 프로젝트만 받는다 — 셸에서 만든 Job 의 새 폴더는 그 어디에도 없어 "허용되지 않은 경로" 로 끝났다.
// 앱이 닫혀 있으면 Host 는 Job 의 cwd 를 읽는다. 앱도 같은 경계를 지킨다.
describe('allowingJobCwds', () => {
  const refuse = async (p: string): Promise<string> => {
    throw new Error(`not allowed: ${p}`)
  }

  it('Job 의 cwd 와 정확히 같은 경로는 가드를 부르지 않고 받는다', async () => {
    const guard = vi.fn(refuse)
    const allow = allowingJobCwds(() => [{ cwd: 'D:/new' }, { cwd: 'D:/other' }], guard)
    await expect(allow('D:/new')).resolves.toBe('D:/new')
    expect(guard).not.toHaveBeenCalled()
  })

  // 그 아래 폴더도, 비슷한 철자도 아니다 — 그 밖의 경로는 전부 원래 가드가 판정한다.
  it('다른 경로는 원래 가드로 간다', async () => {
    const guard = vi.fn(refuse)
    const allow = allowingJobCwds(() => [{ cwd: 'D:/new' }], guard)
    await expect(allow('D:/new/sub')).rejects.toThrow('not allowed: D:/new/sub')
    await expect(allow('D:/ne')).rejects.toThrow('not allowed')
    const ok = allowingJobCwds(() => [], async (p) => `root-of:${p}`)
    await expect(ok('D:/known')).resolves.toBe('root-of:D:/known')
  })

  // 상태는 부를 때마다 읽는다 — 방금 만든 Job 이 바로 받아져야 한다.
  it('Job 목록은 부를 때 읽는다', async () => {
    const jobs: { cwd: string }[] = []
    const allow = allowingJobCwds(() => jobs, refuse)
    await expect(allow('D:/later')).rejects.toThrow()
    jobs.push({ cwd: 'D:/later' })
    await expect(allow('D:/later')).resolves.toBe('D:/later')
  })
})
