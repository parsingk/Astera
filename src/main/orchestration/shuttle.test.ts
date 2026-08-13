import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shuttleFiles, writeShuttle, writeInfo } from './shuttle'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-shuttle-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('shuttleFiles', () => {
  it('모든 셔틀이 ELECTRON_RUN_AS_NODE를 세우고 실행 파일과 엔트리를 부른다', () => {
    const files = shuttleFiles({ execPath: 'C:/App/app.exe', entryPath: 'C:/App/cli/index.mjs' })
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      expect(f.content).toContain('ELECTRON_RUN_AS_NODE')
      expect(f.content).toContain('C:/App/app.exe')
      expect(f.content).toContain('C:/App/cli/index.mjs')
    }
  })
  it('첫 원소(정본)는 win32에서 .cmd, 그 외에는 확장자 없는 이름이다', () => {
    // ASTERA_CLI가 가리키는 것이 이 파일이다 — win32에서 PowerShell·cmd가 확실히 실행할 수 있는
    // 쪽을 정본으로 둔다
    const name = shuttleFiles({ execPath: 'x', entryPath: 'y' })[0].name
    expect(name).toBe(process.platform === 'win32' ? 'astera.cmd' : 'astera')
  })
  it('모든 인자를 그대로 전달한다', () => {
    const files = shuttleFiles({ execPath: 'x', entryPath: 'y' })
    expect(files[0].content).toMatch(process.platform === 'win32' ? /%\*/ : /"\$@"/)
    // sh 셔틀은 어느 플랫폼에서든 "$@"를 쓴다
    expect(files.find((f) => f.name === 'astera')!.content).toMatch(/"\$@"/)
  })
  // 리뷰 지적: MSYS bash는 PATHEXT를 적용하지 않아 `astera`가 `astera.cmd`를 못 찾는다.
  // 확장자 없는 sh 셔틀이 없으면 워커의 유일한 보고 경로(프리앰블의 astera send)가 127로 죽는다.
  it('win32에서는 .cmd와 확장자 없는 sh 셔틀을 둘 다 만든다 — bash가 PATHEXT를 안 본다', () => {
    const names = shuttleFiles({ execPath: 'x', entryPath: 'y' }).map((f) => f.name)
    expect(names).toEqual(process.platform === 'win32' ? ['astera.cmd', 'astera'] : ['astera'])
  })
  it('sh 셔틀은 #!/bin/sh로 시작하고 경로의 역슬래시를 앞슬래시로 바꾼다', () => {
    // sh의 인용 규칙에서 `\`는 이스케이프 문자다 — Windows 경로를 그대로 넣지 않는다.
    // MSYS·Windows API 모두 `C:/...`를 받는다. 그리고 이 `#!`가 MSYS가 파일을 실행 가능으로
    // 보는 근거다(Windows에는 실행 비트가 없다).
    const sh = shuttleFiles({
      execPath: 'C:\\Program\\app.exe',
      entryPath: 'C:\\Program\\out\\cli.js'
    }).find((f) => f.name === 'astera')!
    expect(sh.content.startsWith('#!/bin/sh\n')).toBe(true)
    expect(sh.content).toContain('"C:/Program/app.exe"')
    expect(sh.content).toContain('"C:/Program/out/cli.js"')
    expect(sh.content).not.toContain('\\')
  })
})

describe('writeShuttle', () => {
  it('파일을 만들고 절대경로를 돌려준다', async () => {
    const p = await writeShuttle({ dir, execPath: 'x', entryPath: 'y' })
    expect(path.isAbsolute(p)).toBe(true)
    await expect(fs.readFile(p, 'utf8')).resolves.toContain('ELECTRON_RUN_AS_NODE')
  })
  it('두 번 불러도 덮어쓰고 실패하지 않는다', async () => {
    await writeShuttle({ dir, execPath: 'x', entryPath: 'y' })
    await expect(writeShuttle({ dir, execPath: 'z', entryPath: 'w' })).resolves.toBeTruthy()
  })
  it('돌려주는 경로는 정본(win32=.cmd)이다 — ASTERA_CLI가 그것이다', async () => {
    const p = await writeShuttle({ dir, execPath: 'x', entryPath: 'y' })
    expect(path.basename(p)).toBe(process.platform === 'win32' ? 'astera.cmd' : 'astera')
  })
  it('win32에서도 sh 셔틀 파일이 디스크에 생긴다', async () => {
    await writeShuttle({ dir, execPath: 'x', entryPath: 'y' })
    const names = (await fs.readdir(dir)).sort()
    expect(names).toEqual(process.platform === 'win32' ? ['astera', 'astera.cmd'] : ['astera'])
    await expect(fs.readFile(path.join(dir, 'astera'), 'utf8')).resolves.toContain('#!/bin/sh')
  })
  it('sh 셔틀에 실행 권한을 세운다 (win32는 실행 비트가 없어 #!로 판정된다)', async () => {
    await writeShuttle({ dir, execPath: 'x', entryPath: 'y' })
    const sh = path.join(dir, 'astera')
    if (process.platform === 'win32') {
      // Node의 chmod는 win32에서 읽기 전용 플래그만 건드린다 — 던지지 않는 것과, MSYS가 실제로
      // 보는 신호(`#!`)가 있는 것을 확인한다. bash에서의 실행 자체는 스모크로 실측했다(보고서).
      await expect(fs.access(sh)).resolves.toBeUndefined()
      expect((await fs.readFile(sh, 'utf8')).startsWith('#!')).toBe(true)
      return
    }
    expect((await fs.stat(sh)).mode & 0o111).not.toBe(0)
  })
})

describe('writeInfo', () => {
  it('port와 token을 JSON으로 쓴다', async () => {
    const p = await writeInfo({ dir, port: 51234, token: 'abc' })
    const parsed = JSON.parse(await fs.readFile(p, 'utf8'))
    expect(parsed).toEqual({ port: 51234, token: 'abc' })
  })
  it('토큰 파일은 소유자만 읽고 쓸 수 있는 권한(0o600)으로 만든다 (win32는 POSIX 권한이 없어 제외)', async () => {
    const p = await writeInfo({ dir, port: 1, token: 'x' })
    if (process.platform === 'win32') return
    const stat = await fs.stat(p)
    expect(stat.mode & 0o777).toBe(0o600)
  })
})
