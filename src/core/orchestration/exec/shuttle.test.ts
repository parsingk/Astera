import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  appImageBootstrap,
  ensureShuttle,
  isShuttleContent,
  removeShuttle,
  shuttleFiles,
  shuttleNames,
  shuttleSyncPlan,
  syncShuttle,
  writeShuttle
} from './shuttle'

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

// R6: the Host writes the shuttle at its first spawn, and the app writes the same files at its start,
// so a file that already says the right thing is left alone.
describe('ensureShuttle', () => {
  it('writes nothing the second time for the same pair, and returns the canonical path', async () => {
    const first = await ensureShuttle({ dir, execPath: 'x', entryPath: 'y' })
    const spy = vi.spyOn(fs, 'writeFile')
    try {
      const again = await ensureShuttle({ dir, execPath: 'x', entryPath: 'y' })
      expect(spy).not.toHaveBeenCalled()
      expect(again).toBe(first)
      expect(path.basename(again)).toBe(process.platform === 'win32' ? 'astera.cmd' : 'astera')
    } finally {
      spy.mockRestore()
    }
  })
  it('rewrites the files when the entry path changes', async () => {
    await ensureShuttle({ dir, execPath: 'x', entryPath: 'y' })
    const p = await ensureShuttle({ dir, execPath: 'x', entryPath: 'y2' })
    expect(await fs.readFile(p, 'utf8')).toContain('y2')
    expect(await fs.readFile(path.join(dir, 'astera'), 'utf8')).toContain('y2')
  })
})

// 공개 셔틀의 되돌리기와 갱신(명세 §29–30). 사람이 PATH 에 넣은 폴더는 남의 파일도 사는 곳이라,
// 지우고 다시 쓰는 판단은 "우리가 쓴 파일인가" 에서 시작한다.
describe('shuttleNames (플랫폼 지정)', () => {
  it('win32 은 .cmd 와 sh 둘, 나머지는 sh 하나다', () => {
    expect(shuttleNames('win32')).toEqual(['astera.cmd', 'astera'])
    expect(shuttleNames('linux')).toEqual(['astera'])
    expect(shuttleNames('darwin')).toEqual(['astera'])
  })
})

describe('isShuttleContent', () => {
  const pair = { execPath: 'C:\\App\\Astera.exe', entryPath: 'C:\\App\\resources\\app.asar\\out\\main\\cli.js' }
  it('우리가 쓴 내용은 우리 것으로 본다 (win32 두 파일, posix, AppImage)', () => {
    for (const f of shuttleFiles({ ...pair, platform: 'win32' })) expect(isShuttleContent(f.name, f.content)).toBe(true)
    const posix = shuttleFiles({
      execPath: '/opt/Astera/astera',
      entryPath: '/opt/Astera/resources/app.asar/out/main/cli.js',
      platform: 'linux'
    })
    for (const f of posix) expect(isShuttleContent(f.name, f.content)).toBe(true)
    const ai = shuttleFiles({
      execPath: '/tmp/.mount_AsteraX/astera',
      entryPath: '/tmp/.mount_AsteraX/resources/app.asar/out/main/cli.js',
      appImage: { path: '/home/me/Apps/Astera.AppImage', entryInMount: 'resources/app.asar/out/main/cli.js' },
      platform: 'linux'
    })
    for (const f of ai) expect(isShuttleContent(f.name, f.content)).toBe(true)
  })
  it('사람이나 다른 도구가 쓴 같은 이름의 파일은 우리 것이 아니다', () => {
    expect(isShuttleContent('astera', '#!/bin/sh\necho mine\n')).toBe(false)
    expect(isShuttleContent('astera', '#!/usr/bin/env node\nrequire("astera-other")\n')).toBe(false)
    expect(isShuttleContent('astera.cmd', '@echo off\r\nnode C:\\tools\\astera.js %*\r\n')).toBe(false)
    // 우리 셔틀 뒤에 사람이 한 줄을 덧붙였다면 이제 사람의 파일이다
    const [sh] = shuttleFiles({ execPath: '/a', entryPath: '/b/cli.js', platform: 'linux' })
    expect(isShuttleContent('astera', sh.content + 'echo extra\n')).toBe(false)
  })
  it('모르는 이름은 우리 것이 아니다', () => {
    const [sh] = shuttleFiles({ execPath: '/a', entryPath: '/b/cli.js', platform: 'linux' })
    expect(isShuttleContent('astera-old', sh.content)).toBe(false)
  })
})

describe('shuttleSyncPlan', () => {
  const desired = shuttleFiles({ execPath: 'C:\\New\\Astera.exe', entryPath: 'C:\\New\\cli.js', platform: 'win32' })
  const old = shuttleFiles({ execPath: 'C:\\Old\\Astera.exe', entryPath: 'C:\\Old\\cli.js', platform: 'win32' })
  const current = (files: { name: string; content: string }[]): Record<string, string | null> =>
    Object.fromEntries(files.map((f) => [f.name, f.content]))

  it('설치된 적이 없으면 깔지 않는다', () => {
    expect(shuttleSyncPlan({ current: { 'astera.cmd': null, astera: null }, desired })).toBe('not-installed')
  })
  it('한쪽만 있으면 설치된 것으로 보지 않는다 (없는 파일을 쓰는 것은 설치다)', () => {
    expect(shuttleSyncPlan({ current: { 'astera.cmd': old[0].content, astera: null }, desired })).toBe(
      'not-installed'
    )
  })
  it('같은 이름이라도 남의 파일이 하나라도 있으면 건드리지 않는다', () => {
    expect(
      shuttleSyncPlan({ current: { 'astera.cmd': old[0].content, astera: '#!/bin/sh\necho mine\n' }, desired })
    ).toBe('foreign')
  })
  it('이미 지금의 앱을 가리키면 쓰지 않는다', () => {
    expect(shuttleSyncPlan({ current: current(desired), desired })).toBe('current')
  })
  it('예전 앱을 가리키는 우리 셔틀은 다시 쓴다', () => {
    expect(shuttleSyncPlan({ current: current(old), desired })).toBe('rewrite')
  })
})

describe('removeShuttle', () => {
  it('우리가 쓴 파일만 지우고 이웃 파일과 폴더는 남긴다', async () => {
    await writeShuttle({ dir, execPath: '/opt/Astera/astera', entryPath: '/opt/Astera/cli.js' })
    await fs.writeFile(path.join(dir, 'kubectl'), 'someone else', 'utf8')
    await fs.writeFile(path.join(dir, 'astera.bak'), 'a backup the person made', 'utf8')
    const removed = await removeShuttle({ dir })
    expect([...removed].sort()).toEqual([...shuttleNames()].sort())
    expect((await fs.readdir(dir)).sort()).toEqual(['astera.bak', 'kubectl'])
  })
  it('같은 이름이라도 우리 내용이 아니면 지우지 않는다', async () => {
    await fs.writeFile(path.join(dir, 'astera'), '#!/bin/sh\necho mine\n', 'utf8')
    expect(await removeShuttle({ dir, platform: 'linux' })).toEqual([])
    await expect(fs.readFile(path.join(dir, 'astera'), 'utf8')).resolves.toBe('#!/bin/sh\necho mine\n')
  })
  it('비어도 폴더를 지우지 않고, 없는 폴더에도 실패하지 않는다', async () => {
    await writeShuttle({ dir, execPath: 'x', entryPath: 'y/cli.js' })
    await removeShuttle({ dir })
    await expect(fs.readdir(dir)).resolves.toEqual([])
    await expect(removeShuttle({ dir: path.join(dir, 'nope') })).resolves.toEqual([])
  })
})

describe('syncShuttle', () => {
  it('설치되어 있지 않으면 아무것도 쓰지 않는다', async () => {
    expect(await syncShuttle({ dir, execPath: 'x', entryPath: 'y/cli.js' })).toBe('not-installed')
    await expect(fs.readdir(dir)).resolves.toEqual([])
  })
  it('설치되어 있으면 지금의 앱을 가리키게 다시 쓴다', async () => {
    await writeShuttle({ dir, execPath: '/old/astera', entryPath: '/old/cli.js' })
    expect(await syncShuttle({ dir, execPath: '/new/astera', entryPath: '/new/cli.js' })).toBe('rewrite')
    for (const n of shuttleNames()) expect(await fs.readFile(path.join(dir, n), 'utf8')).toContain('/new/cli.js')
  })
  it('남의 파일이 그 이름을 쓰고 있으면 두고 온다', async () => {
    await fs.writeFile(path.join(dir, 'astera'), '#!/bin/sh\necho mine\n', 'utf8')
    expect(await syncShuttle({ dir, execPath: '/new/astera', entryPath: '/new/cli.js', platform: 'linux' })).toBe(
      'foreign'
    )
    await expect(fs.readFile(path.join(dir, 'astera'), 'utf8')).resolves.toBe('#!/bin/sh\necho mine\n')
  })
})

// AppImage 의 process.execPath 는 실행할 때마다 바뀌는 임시 마운트다(/tmp/.mount_*). 공개 셔틀은
// 진짜 파일($APPIMAGE)을 부르고, 엔트리는 그 실행이 새로 만든 마운트($APPDIR) 안에서 찾는다.
describe('AppImage 셔틀', () => {
  const appImage = { path: '/home/me/Apps/Astera.AppImage', entryInMount: 'resources/app.asar/out/main/cli.js' }
  const files = shuttleFiles({
    execPath: '/tmp/.mount_AsteraX/astera',
    entryPath: '/tmp/.mount_AsteraX/resources/app.asar/out/main/cli.js',
    appImage,
    platform: 'linux'
  })
  it('임시 마운트가 아니라 AppImage 파일을 부른다', () => {
    expect(files.map((f) => f.name)).toEqual(['astera'])
    expect(files[0].content).toContain('exec "/home/me/Apps/Astera.AppImage"')
    expect(files[0].content).not.toContain('.mount_')
    expect(files[0].content).toContain('ELECTRON_RUN_AS_NODE=1')
  })
  // electron-builder 의 AppRun 은 사용자 네임스페이스가 막힌 시스템에서 --no-sandbox 를 앞에 붙인다.
  // node 모드에서는 모르는 옵션이라 죽는다. 스크립트 인자 자리에 먼저 넣어 두면 AppRun 은 붙이지
  // 않고, 부트스트랩이 그것을 걷는다.
  it('AppRun 이 --no-sandbox 를 덧붙이지 않게 스크립트 인자 자리에 먼저 넣는다', () => {
    expect(files[0].content).toMatch(/ astera --no-sandbox "\$@"\n$/)
  })
  it('부트스트랩이 $APPDIR 안의 엔트리를 부르고 argv 를 보통 실행과 같게 맞춘다', async () => {
    await fs.writeFile(path.join(dir, 'cli.js'), 'console.log(JSON.stringify(process.argv.slice(1)))\n', 'utf8')
    const out = execFileSync(
      process.execPath,
      ['-e', appImageBootstrap('cli.js'), 'astera', '--no-sandbox', 'jobs', '--json', "it's"],
      { env: { ...process.env, APPDIR: dir }, encoding: 'utf8' }
    )
    expect(JSON.parse(out)).toEqual([`${dir}/cli.js`, 'jobs', '--json', "it's"])
  })
})
