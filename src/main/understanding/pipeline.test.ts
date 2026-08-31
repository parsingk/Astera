// 파이프라인을 끝에서 끝까지 — 에이전트만 가짜로 두고 나머지는 진짜다(진짜 저장소 파일,
// 진짜 순수 함수, 진짜 검증).
//
// **에이전트를 가짜로 두는 이유**: 진짜 CLI 왕복은 수십 초이고 답이 매번 다르다. 여기서 물어야
// 하는 것은 "에이전트가 좋은 설명을 쓰는가"가 아니라 "그 답이 어떻게 흐르고, 실패하면 어떻게
// 되는가"다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SessionWorkUnit } from '../../core/workUnit/types'
import { UnderstandingStore } from './store'
import { UnderstandingPipeline } from './pipeline'

let dir: string
let storeFile: string
let projectRoot: string

const account = { id: 'a1', label: 'acc', configDir: 'C:\\cfg', color: '#fff', createdAt: '2026-01-01T00:00:00.000Z' }

async function make(generator: { accountId?: string } = { accountId: 'a1' }): Promise<{
  store: UnderstandingStore
  pipeline: UnderstandingPipeline
  /** 화면으로 나간 알림. 여기가 비면 배경 재생성의 결과는 화면에 닿지 않는다 */
  changed: string[]
}> {
  const store = new UnderstandingStore(storeFile)
  await store.load()
  const changed: string[] = []
  const pipeline = new UnderstandingPipeline({
    store,
    accountOf: (id) => (id === 'a1' ? account : null),
    descriptors: {} as never,
    generator: () => generator,
    now: () => '2026-08-30T12:00:00.000Z',
    onChanged: (root) => changed.push(root)
  })
  return { store, pipeline, changed }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-hiw-pipe-'))
  storeFile = path.join(dir, 'understanding.json')
  projectRoot = path.join(dir, 'project')
  await fs.mkdir(path.join(projectRoot, 'src', 'auth'), { recursive: true })
  await fs.writeFile(path.join(projectRoot, 'src', 'auth', 'login.ts'), '// login', 'utf8')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

// Placeholder — Task 2 fills the pipeline back in against the record model. This just proves the
// shell (store + deps wiring via make()) holds together on its own until then.
describe('UnderstandingPipeline', () => {
  it('만들어질 때 저장소를 건드리지 않는다', async () => {
    const { store } = await make()
    expect(store.get(projectRoot)).toBeUndefined()
  })
})
