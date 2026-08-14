import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listDotnetProjects } from './dotnetScanner'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-dotnet-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** 프로젝트 안에 빈 파일 하나를 만든다 — 스캐너는 내용을 읽지 않고 이름만 본다 */
const touch = async (rel: string): Promise<void> => {
  const full = path.join(dir, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, '', 'utf8')
}

describe('listDotnetProjects', () => {
  it('csproj·fsproj·sln 을 프로젝트 상대 경로로 모은다', async () => {
    await touch('App.sln')
    await touch(path.join('src', 'App', 'App.csproj'))
    await touch(path.join('src', 'Lib', 'Lib.fsproj'))
    await touch(path.join('src', 'App', 'Program.cs')) // 프로젝트 파일이 아니다
    expect(await listDotnetProjects(dir)).toEqual([
      'App.sln',
      path.join('src', 'App', 'App.csproj'),
      path.join('src', 'Lib', 'Lib.fsproj')
    ])
  })

  // 큰 저장소에서 전체 훑기는 느리다 — 하위 3 단계까지만 본다
  it('하위 3 단계까지만 훑는다', async () => {
    await touch(path.join('a', 'b', 'c', 'Deep.csproj'))
    await touch(path.join('a', 'b', 'c', 'd', 'TooDeep.csproj'))
    expect(await listDotnetProjects(dir)).toEqual([path.join('a', 'b', 'c', 'Deep.csproj')])
  })

  it('node_modules·bin·obj·.git 은 건너뛴다', async () => {
    await touch(path.join('node_modules', 'pkg', 'Pkg.csproj'))
    await touch(path.join('src', 'bin', 'Debug', 'App.csproj'))
    await touch(path.join('src', 'obj', 'App.csproj'))
    await touch(path.join('.git', 'x', 'X.csproj'))
    await touch(path.join('src', 'App.csproj'))
    expect(await listDotnetProjects(dir)).toEqual([path.join('src', 'App.csproj')])
  })

  // 실패는 빈 목록이다 — 스캔 실패가 IPC 호출자에게 던져 올라가면 폼 자체가 열리지 않는다
  it('읽을 수 없는 경로는 빈 목록이다', async () => {
    expect(await listDotnetProjects(path.join(dir, 'nope'))).toEqual([])
  })
})
