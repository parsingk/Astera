// 설치 폴더 이름에 ASCII 밖 글자가 들어 있고 그 폴더가 사용자 폴더 밖에 있을 때(`D:\프로그램\Astera`),
// 공개 .cmd 셔틀은 `%LOCALAPPDATA%\astera\app` 정션을 거쳐 앱을 부른다. cmd.exe 는 배치 파일을 OEM
// 코드 페이지로 읽어 그 이름을 깨뜨리고(shuttle.ts 의 forCmd), 사용자 폴더 변수로도 적을 수 없기 때문이다.
//
// 정션을 만들고 지우는 일은 LinkFs 로 주입한다. 가짜로 대부분을 보고(어느 운영체제에서도 돈다), 진짜
// 정션과 cmd.exe 로 한 번 본다(win32 에서만).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  cmdLinkFor,
  ensureShuttle,
  installShuttle,
  isShuttleContent,
  removeShuttle,
  sessionCmdLink,
  shuttleFiles,
  syncShuttle,
  writeShuttle,
  type LinkFs,
  type ShuttleWarning
} from './shuttle'

const ASCII = /^[\x20-\x7e\r\n]*$/
const ROOT = 'D:\\프로그램\\Astera'
const EXEC = `${ROOT}\\Astera.exe`
const ENTRY = `${ROOT}\\resources\\app.asar\\out\\main\\cli.js`
// 사용자 이름이 ASCII 인 사람: 설치 폴더는 이 밖에 있다
const env = {
  USERPROFILE: 'C:\\Users\\me',
  APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local'
} as NodeJS.ProcessEnv

let dir: string
let link: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-junction-'))
  link = path.win32.join(path.win32.dirname(dir), 'app')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** 정션을 기억만 하는 LinkFs. `links` 는 링크 경로 → 대상, `others` 는 링크가 아닌 것이 있는 경로. */
function fakeLinks(init: { links?: Record<string, string>; others?: string[]; symlinkFails?: string } = {}) {
  const links = new Map(Object.entries(init.links ?? {}))
  const others = new Set(init.others ?? [])
  const calls: string[] = []
  const enoent = (p: string): Error => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
  const api: LinkFs = {
    lstat: async (p) => {
      if (links.has(p)) return { isSymbolicLink: () => true }
      if (others.has(p)) return { isSymbolicLink: () => false }
      throw enoent(p)
    },
    readlink: async (p) => {
      const t = links.get(p)
      if (t === undefined) throw enoent(p)
      return t
    },
    symlink: async (target, p, type) => {
      calls.push(`symlink ${type} ${p} -> ${target}`)
      if (init.symlinkFails) throw Object.assign(new Error(init.symlinkFails), { code: 'EPERM' })
      links.set(p, target)
    },
    unlink: async (p) => {
      calls.push(`unlink ${p}`)
      if (!links.has(p)) throw new Error(`not a link: ${p}`)
      links.delete(p)
    }
  }
  return { api, links, others, calls }
}

const cmdIn = async (d: string): Promise<string> => fs.readFile(path.join(d, 'astera.cmd'), 'utf8')

describe('cmdLinkFor', () => {
  it('사용자 폴더 밖의 ASCII 밖 설치 폴더는 정션을 고른다', () => {
    expect(cmdLinkFor({ dir: 'C:\\Users\\me\\AppData\\Local\\astera\\bin', execPath: EXEC, entryPath: ENTRY, env })).toEqual({
      kind: 'link',
      link: { link: 'C:\\Users\\me\\AppData\\Local\\astera\\app', root: ROOT }
    })
  })
  it('ASCII 경로는 정션이 필요 없다', () => {
    const r = cmdLinkFor({ dir: 'C:\\x\\bin', execPath: 'D:\\Apps\\Astera\\Astera.exe', entryPath: 'D:\\Apps\\Astera\\cli.js', env })
    expect(r).toEqual({ kind: 'none' })
  })
  it('사용자 폴더 안의 ASCII 밖 경로는 변수로 적으면 되므로 정션이 필요 없다', () => {
    const home = 'C:\\Users\\홍길동'
    const e = { USERPROFILE: home, LOCALAPPDATA: `${home}\\AppData\\Local` } as NodeJS.ProcessEnv
    const app = `${home}\\AppData\\Local\\Programs\\Astera`
    expect(cmdLinkFor({ dir: `${home}\\AppData\\Local\\astera\\bin`, execPath: `${app}\\Astera.exe`, entryPath: `${app}\\cli.js`, env: e })).toEqual({ kind: 'none' })
  })
  it('설치 폴더 아래의 나머지가 ASCII 가 아니거나 엔트리가 그 밖에 있으면 정션으로도 안 된다', () => {
    const dirX = 'C:\\x\\bin'
    expect(cmdLinkFor({ dir: dirX, execPath: EXEC, entryPath: `${ROOT}\\자료\\cli.js`, env })).toMatchObject({
      kind: 'unsuitable',
      reason: 'remainder-not-ascii'
    })
    expect(cmdLinkFor({ dir: dirX, execPath: EXEC, entryPath: 'E:\\다른곳\\cli.js', env })).toMatchObject({
      kind: 'unsuitable',
      reason: 'entry-outside-root'
    })
  })
})

describe('shuttleFiles 와 정션', () => {
  it('정션을 받으면 .cmd 의 두 경로를 %LOCALAPPDATA%\\astera\\app 아래로 적고, 모양은 우리 것 그대로다', () => {
    const [cmd, sh] = shuttleFiles({
      execPath: EXEC,
      entryPath: ENTRY,
      platform: 'win32',
      env,
      link: { link: 'C:\\Users\\me\\AppData\\Local\\astera\\app', root: ROOT }
    })
    expect(cmd.content).toBe(
      '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%LOCALAPPDATA%\\astera\\app\\Astera.exe" "%LOCALAPPDATA%\\astera\\app\\resources\\app.asar\\out\\main\\cli.js" %*\r\n'
    )
    expect(isShuttleContent('astera.cmd', cmd.content)).toBe(true)
    // bash 는 UTF-8 로 읽으니 sh 셔틀은 진짜 경로 그대로다
    expect(sh.content).toContain('"D:/프로그램/Astera/Astera.exe"')
  })
})

describe('installShuttle (win32, 정션)', () => {
  const install = (links: LinkFs, execPath = EXEC, entryPath = ENTRY) =>
    installShuttle({ dir, execPath, entryPath, platform: 'win32', env, links })

  it('사용자 폴더 밖의 ASCII 밖 경로면 정션을 만들고 셔틀을 그것으로 적는다', async () => {
    const f = fakeLinks()
    const r = await install(f.api)
    expect(f.calls).toEqual([`symlink junction ${link} -> ${ROOT}`])
    expect(r.warnings).toEqual([])
    expect(r.path).toBe(path.join(dir, 'astera.cmd'))
    const cmd = await cmdIn(dir)
    expect(cmd).toMatch(ASCII)
    expect(cmd).toContain(`"${link}\\Astera.exe" "${link}\\resources\\app.asar\\out\\main\\cli.js"`)
  })

  it('ASCII 경로는 정션 없이 지금처럼 적는다', async () => {
    const f = fakeLinks()
    const execPath = 'D:\\Apps\\Astera\\Astera.exe'
    const entryPath = 'D:\\Apps\\Astera\\resources\\app.asar\\out\\main\\cli.js'
    const r = await install(f.api, execPath, entryPath)
    expect(f.calls).toEqual([])
    expect(r.warnings).toEqual([])
    expect(await cmdIn(dir)).toBe(shuttleFiles({ execPath, entryPath, platform: 'win32', env })[0].content)
  })

  it('사용자 폴더 안의 경로는 여전히 변수로 적고 정션을 만들지 않는다', async () => {
    const home = 'C:\\Users\\홍길동'
    const e = { USERPROFILE: home, LOCALAPPDATA: `${home}\\AppData\\Local` } as NodeJS.ProcessEnv
    const app = `${home}\\AppData\\Local\\Programs\\Astera`
    const f = fakeLinks()
    const r = await installShuttle({ dir, execPath: `${app}\\Astera.exe`, entryPath: `${app}\\cli.js`, platform: 'win32', env: e, links: f.api })
    expect(f.calls).toEqual([])
    expect(r.warnings).toEqual([])
    expect(await cmdIn(dir)).toContain('"%LOCALAPPDATA%\\Programs\\Astera\\Astera.exe" "%LOCALAPPDATA%\\Programs\\Astera\\cli.js"')
  })

  it('정션을 못 만들면 지금처럼 진짜 경로를 적고 경고를 돌려준다', async () => {
    const f = fakeLinks({ symlinkFails: 'EPERM: operation not permitted' })
    const r = await install(f.api)
    expect(r.warnings).toEqual([
      expect.objectContaining<Partial<ShuttleWarning>>({ code: 'junction-failed' })
    ])
    expect(r.warnings[0].detail).toContain('EPERM')
    expect(await cmdIn(dir)).toBe(shuttleFiles({ execPath: EXEC, entryPath: ENTRY, platform: 'win32', env })[0].content)
  })

  it('그 자리에 정션이 아닌 폴더나 파일이 있으면 건드리지 않고, 진짜 경로를 적고 알린다', async () => {
    const f = fakeLinks({ others: [link] })
    const r = await install(f.api)
    expect(f.calls).toEqual([])
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'link-path-taken' })])
    expect(await cmdIn(dir)).toContain(`"${EXEC}"`)
  })

  it('다른 곳을 가리키는 예전 정션은 앱이 옮긴 것이므로 다시 가리키게 한다', async () => {
    const f = fakeLinks({ links: { [link]: 'E:\\옛 자리\\Astera' } })
    const r = await install(f.api)
    expect(f.calls).toEqual([`unlink ${link}`, `symlink junction ${link} -> ${ROOT}`])
    expect(r.warnings).toEqual([])
    expect(f.links.get(link)).toBe(ROOT)
  })

  it('이미 지금의 설치 폴더를 가리키는 정션은 그대로 둔다 (대소문자, 끝 구분자, \\\\?\\ 는 같게 본다)', async () => {
    const f = fakeLinks({ links: { [link]: `\\\\?\\d:\\프로그램\\astera\\` } })
    await install(f.api)
    expect(f.calls).toEqual([])
  })

  it('더는 정션이 필요 없는 셔틀을 쓰면 남은 정션을 걷는다 (링크만)', async () => {
    const f = fakeLinks({ links: { [link]: ROOT } })
    await install(f.api, 'D:\\Apps\\Astera\\Astera.exe', 'D:\\Apps\\Astera\\cli.js')
    expect(f.calls).toEqual([`unlink ${link}`])
  })

  it('정션으로도 안 되는 경로는 진짜 경로를 적고 알린다', async () => {
    const f = fakeLinks()
    const r = await install(f.api, EXEC, 'E:\\다른곳\\cli.js')
    expect(f.calls).toEqual([])
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'junction-unsuitable' })])
  })

  it('win32 이 아니면 정션을 모른다', async () => {
    const f = fakeLinks()
    const r = await installShuttle({ dir, execPath: '/opt/프로그램/astera', entryPath: '/opt/프로그램/cli.js', platform: 'linux', env, links: f.api })
    expect(f.calls).toEqual([])
    expect(r.warnings).toEqual([])
  })
})

describe('syncShuttle (win32, 정션)', () => {
  it('설치되어 있지 않으면 정션도 만들지 않는다', async () => {
    const f = fakeLinks()
    expect(await syncShuttle({ dir, execPath: EXEC, entryPath: ENTRY, platform: 'win32', env, links: f.api })).toBe('not-installed')
    expect(f.calls).toEqual([])
  })

  it('남의 파일이 있으면 정션도 만들지 않는다', async () => {
    await fs.writeFile(path.join(dir, 'astera.cmd'), '@echo off\r\nmine\r\n', 'utf8')
    await fs.writeFile(path.join(dir, 'astera'), '#!/bin/sh\necho mine\n', 'utf8')
    const f = fakeLinks()
    expect(await syncShuttle({ dir, execPath: EXEC, entryPath: ENTRY, platform: 'win32', env, links: f.api })).toBe('foreign')
    expect(f.calls).toEqual([])
  })

  it('앱이 ASCII 밖 폴더로 옮겨 가면 정션을 만들고 셔틀을 그것으로 다시 쓴다', async () => {
    await writeShuttle({ dir, execPath: 'D:\\Old\\Astera.exe', entryPath: 'D:\\Old\\cli.js', platform: 'win32', env })
    const f = fakeLinks()
    expect(await syncShuttle({ dir, execPath: EXEC, entryPath: ENTRY, platform: 'win32', env, links: f.api })).toBe('rewrite')
    expect(f.links.get(link)).toBe(ROOT)
    expect(await cmdIn(dir)).toContain(`"${link}\\Astera.exe"`)
  })

  // sh 셔틀은 진짜 경로를 적으니 다시 쓰이지만, .cmd 는 한 글자도 바뀌지 않는다. 정션이 옛 자리를
  // 가리킨 채였다면 cmd 의 astera 는 옛 앱을 부르거나 죽는다.
  it('정션으로 적은 셔틀은 우리 것이고, 앱이 옮겨 가면 .cmd 가 그대로여도 정션을 다시 가리키게 한다', async () => {
    const f = fakeLinks()
    await installShuttle({ dir, execPath: 'E:\\옛 자리\\Astera\\Astera.exe', entryPath: 'E:\\옛 자리\\Astera\\resources\\app.asar\\out\\main\\cli.js', platform: 'win32', env, links: f.api })
    const before = await cmdIn(dir)
    f.calls.length = 0
    expect(await syncShuttle({ dir, execPath: EXEC, entryPath: ENTRY, platform: 'win32', env, links: f.api })).toBe('rewrite')
    expect(await cmdIn(dir)).toBe(before)
    expect(f.calls).toEqual([`unlink ${link}`, `symlink junction ${link} -> ${ROOT}`])
    // 다음 부팅은 할 일이 없다
    f.calls.length = 0
    expect(await syncShuttle({ dir, execPath: EXEC, entryPath: ENTRY, platform: 'win32', env, links: f.api })).toBe('current')
    expect(f.calls).toEqual([])
  })

  it('정션을 못 만들면 진짜 경로로 다시 쓰고 경고를 넘긴다', async () => {
    await writeShuttle({ dir, execPath: 'D:\\Old\\Astera.exe', entryPath: 'D:\\Old\\cli.js', platform: 'win32', env })
    const f = fakeLinks({ symlinkFails: 'EINVAL: FAT volume' })
    const warnings: ShuttleWarning[] = []
    expect(
      await syncShuttle({ dir, execPath: EXEC, entryPath: ENTRY, platform: 'win32', env, links: f.api, onWarning: (w) => warnings.push(w) })
    ).toBe('rewrite')
    expect(warnings.map((w) => w.code)).toEqual(['junction-failed'])
    expect(await cmdIn(dir)).toContain(`"${EXEC}"`)
  })
})

describe('removeShuttle (win32, 정션)', () => {
  it('우리 셔틀을 걷을 때 정션도 걷는다, 링크로만', async () => {
    const f = fakeLinks()
    await installShuttle({ dir, execPath: EXEC, entryPath: ENTRY, platform: 'win32', env, links: f.api })
    f.calls.length = 0
    expect((await removeShuttle({ dir, platform: 'win32', links: f.api })).sort()).toEqual(['astera', 'astera.cmd'])
    expect(f.calls).toEqual([`unlink ${link}`])
  })

  it('그 자리가 정션이 아니면 두고 온다', async () => {
    await writeShuttle({ dir, execPath: EXEC, entryPath: ENTRY, platform: 'win32', env })
    const f = fakeLinks({ others: [link] })
    await removeShuttle({ dir, platform: 'win32', links: f.api })
    expect(f.calls).toEqual([])
  })

  it('남의 astera.cmd 가 남아 있으면 정션도 두고 온다', async () => {
    await fs.writeFile(path.join(dir, 'astera.cmd'), '@echo off\r\nmine\r\n', 'utf8')
    const f = fakeLinks({ links: { [link]: ROOT } })
    await removeShuttle({ dir, platform: 'win32', links: f.api })
    expect(f.calls).toEqual([])
  })
})

// 진짜 정션과 진짜 cmd.exe 로. 설치 폴더를 사용자 폴더 밖으로 보이게 하려고 사용자 폴더 변수를 비운
// env 로 셔틀을 쓴다(임시 폴더는 사용자 폴더 안에 있다).
describe.runIf(process.platform === 'win32')('진짜 정션', () => {
  it('정션을 거친 셔틀이 돌고, 제거는 정션만 걷고 설치 폴더는 남긴다', async () => {
    const root = path.join(dir, '설치 폴더')
    const entry = path.join(root, 'resources', 'entry.js')
    await fs.mkdir(path.dirname(entry), { recursive: true })
    await fs.writeFile(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n', 'utf8')
    const exe = path.join(root, 'Astera.exe')
    await fs.copyFile(process.execPath, exe)
    const bin = path.join(dir, 'astera', 'bin')
    const r = await installShuttle({ dir: bin, execPath: exe, entryPath: entry, platform: 'win32', env: {} })
    expect(r.warnings).toEqual([])
    const appLink = path.join(dir, 'astera', 'app')
    expect((await fs.lstat(appLink)).isSymbolicLink()).toBe(true)
    expect(await cmdIn(bin)).toMatch(ASCII)
    const run = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${r.path}" hello "a b""`], {
      windowsVerbatimArguments: true,
      encoding: 'utf8'
    })
    expect(run.stderr).toBe('')
    expect(JSON.parse(run.stdout)).toEqual(['hello', 'a b'])
    await removeShuttle({ dir: bin, platform: 'win32' })
    await expect(fs.lstat(appLink)).rejects.toThrow()
    await expect(fs.readFile(entry, 'utf8')).resolves.toContain('argv')
  })
})

// 앱이 자기 세션에 주는 셔틀(`<userData>\orch`, bootOrch 와 Host 의 ensureShuttle)도 같은 정션을 쓴다.
// 세션 쪽은 정션을 만들거나 다시 가리키게만 하고 **걷지 않는다.** 걷는 것은 공개 셔틀 제거와 NSIS 뿐이다.
describe('sessionCmdLink (세션 셔틀의 정션)', () => {
  const publicDir = 'C:\\Users\\me\\AppData\\Local\\astera\\bin'
  const appLink = 'C:\\Users\\me\\AppData\\Local\\astera\\app'
  const run = (links: LinkFs, execPath = EXEC, entryPath = ENTRY) => {
    const warnings: ShuttleWarning[] = []
    return sessionCmdLink({ publicDir, execPath, entryPath, platform: 'win32', env, links }, (w) => warnings.push(w)).then(
      (link) => ({ link, warnings })
    )
  }

  it('필요하면 공개 셔틀과 같은 자리에 정션을 만들고 그것을 돌려준다', async () => {
    const f = fakeLinks()
    const r = await run(f.api)
    expect(r.link).toEqual({ link: appLink, root: ROOT })
    expect(f.calls).toEqual([`symlink junction ${appLink} -> ${ROOT}`])
    expect(r.warnings).toEqual([])
  })

  it('옛 자리를 가리키는 정션은 다시 가리키게 한다', async () => {
    const f = fakeLinks({ links: { [appLink]: 'E:\\옛 자리\\Astera' } })
    expect((await run(f.api)).link).toEqual({ link: appLink, root: ROOT })
    expect(f.calls).toEqual([`unlink ${appLink}`, `symlink junction ${appLink} -> ${ROOT}`])
  })

  it('필요 없어도 있는 정션을 걷지 않는다 (공개 셔틀이 쓰고 있을 수 있다)', async () => {
    const f = fakeLinks({ links: { [appLink]: ROOT } })
    const r = await run(f.api, 'D:\\Apps\\Astera\\Astera.exe', 'D:\\Apps\\Astera\\cli.js')
    expect(r.link).toBeUndefined()
    expect(f.calls).toEqual([])
  })

  it('못 만들면 undefined 와 경고, 정션이 아닌 것은 건드리지 않는다', async () => {
    const failed = await run(fakeLinks({ symlinkFails: 'EPERM' }).api)
    expect(failed.link).toBeUndefined()
    expect(failed.warnings.map((w) => w.code)).toEqual(['junction-failed'])
    const taken = fakeLinks({ others: [appLink] })
    const r = await run(taken.api)
    expect(r.link).toBeUndefined()
    expect(r.warnings.map((w) => w.code)).toEqual(['link-path-taken'])
    expect(taken.calls).toEqual([])
  })

  it('앱(writeShuttle)과 Host(ensureShuttle)가 같은 정션으로 같은 .cmd 를 쓴다: 두 번째는 다시 쓰지 않는다', async () => {
    const link = { link: appLink, root: ROOT }
    await writeShuttle({ dir, execPath: EXEC, entryPath: ENTRY, platform: 'win32', env, link })
    const before = await fs.stat(path.join(dir, 'astera.cmd'))
    await new Promise((r) => setTimeout(r, 20))
    await ensureShuttle({ dir, execPath: EXEC, entryPath: ENTRY, platform: 'win32', env, link })
    expect((await fs.stat(path.join(dir, 'astera.cmd'))).mtimeMs).toBe(before.mtimeMs)
    expect(await cmdIn(dir)).toContain('"%LOCALAPPDATA%\\astera\\app\\Astera.exe"')
  })
})

describe('removeShuttle 와 지금 도는 앱의 세션 셔틀', () => {
  it('지금 도는 앱의 세션 셔틀이 정션을 거치면 공개 셔틀을 걷어도 정션은 남긴다', async () => {
    const f = fakeLinks()
    await installShuttle({ dir, execPath: EXEC, entryPath: ENTRY, platform: 'win32', env, links: f.api })
    f.calls.length = 0
    const removed = await removeShuttle({ dir, platform: 'win32', links: f.api, keepFor: { execPath: EXEC, entryPath: ENTRY, env } })
    expect(removed.sort()).toEqual(['astera', 'astera.cmd'])
    expect(f.calls).toEqual([])
    expect(f.links.get(link)).toBe(ROOT)
  })

  it('지금 도는 앱이 정션을 쓰지 않으면(ASCII 폴더) 공개 셔틀과 함께 걷는다', async () => {
    const f = fakeLinks()
    await installShuttle({ dir, execPath: EXEC, entryPath: ENTRY, platform: 'win32', env, links: f.api })
    f.calls.length = 0
    await removeShuttle({
      dir,
      platform: 'win32',
      links: f.api,
      keepFor: { execPath: 'D:\\Apps\\Astera\\Astera.exe', entryPath: 'D:\\Apps\\Astera\\cli.js', env }
    })
    expect(f.calls).toEqual([`unlink ${link}`])
  })
})

describe.runIf(process.platform === 'win32')('진짜 정션 (세션 셔틀)', () => {
  it('세션 셔틀의 .cmd 가 정션을 거쳐 돈다', async () => {
    const root = path.join(dir, '설치 폴더')
    const entry = path.join(root, 'resources', 'entry.js')
    await fs.mkdir(path.dirname(entry), { recursive: true })
    await fs.writeFile(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n', 'utf8')
    const exe = path.join(root, 'Astera.exe')
    await fs.copyFile(process.execPath, exe)
    const publicDir = path.join(dir, 'astera', 'bin')
    const warnings: ShuttleWarning[] = []
    const l = await sessionCmdLink({ publicDir, execPath: exe, entryPath: entry, platform: 'win32', env: {} }, (w) => warnings.push(w))
    expect(warnings).toEqual([])
    const shim = await writeShuttle({ dir: path.join(dir, 'profile', 'orch'), execPath: exe, entryPath: entry, platform: 'win32', env: {}, link: l })
    expect(await fs.readFile(shim, 'utf8')).toMatch(ASCII)
    const run = spawnSync('cmd.exe', ['/d', '/s', '/c', `"chcp 949 >nul & "${shim}" hi"`], { windowsVerbatimArguments: true, encoding: 'utf8' })
    expect(JSON.parse(run.stdout)).toEqual(['hi'])
    await fs.unlink(path.join(dir, 'astera', 'app'))
  })
})

// 부팅 때 세 자리가 같은 정션을 동시에 만들려 한다: 공개 셔틀 동기화(syncShuttle, 기다리지 않음),
// bootOrch 의 sessionCmdLink, Host 의 첫 spawn. 진 쪽이 EEXIST 나 ENOENT 를 실패로 보고 진짜 경로를
// 적으면 안 된다. `before` 는 우리가 본 뒤, 우리 호출 직전에 다른 작성자가 한 일이다.
describe('정션 경합', () => {
  const racing = (init: { target?: string; beforeSymlink?: (links: Map<string, string>) => void; beforeUnlink?: (links: Map<string, string>) => void }) => {
    const f = fakeLinks(init.target ? { links: { [link]: init.target } } : {})
    const api: LinkFs = {
      ...f.api,
      symlink: async (target, p, type) => {
        init.beforeSymlink?.(f.links)
        if (f.links.has(p)) throw Object.assign(new Error(`EEXIST: ${p}`), { code: 'EEXIST' })
        return f.api.symlink(target, p, type)
      },
      unlink: async (p) => {
        init.beforeUnlink?.(f.links)
        if (!f.links.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
        return f.api.unlink(p)
      }
    }
    return { ...f, api }
  }
  const install = (links: LinkFs) => installShuttle({ dir, execPath: EXEC, entryPath: ENTRY, platform: 'win32', env, links })

  it('만들려는 순간 다른 작성자가 같은 대상으로 만들었으면(EEXIST) 성공으로 본다', async () => {
    const f = racing({ beforeSymlink: (links) => void links.set(link, `${ROOT}\\`) })
    const r = await install(f.api)
    expect(r.warnings).toEqual([])
    expect(await cmdIn(dir)).toContain(`"${link}\\Astera.exe"`)
  })

  it('EEXIST 뒤에 다시 읽은 정션이 다른 곳을 가리키면 여전히 실패다', async () => {
    const f = racing({ beforeSymlink: (links) => void links.set(link, 'E:\\다른 앱') })
    const r = await install(f.api)
    expect(r.warnings.map((w) => w.code)).toEqual(['junction-failed'])
    expect(await cmdIn(dir)).toContain(`"${EXEC}"`)
  })

  it('다시 가리키려 걷는 순간 다른 작성자가 먼저 걷었으면(ENOENT) 그대로 만든다', async () => {
    const f = racing({ target: 'E:\\옛 자리\\Astera', beforeUnlink: (links) => void links.delete(link) })
    const r = await install(f.api)
    expect(r.warnings).toEqual([])
    expect(f.links.get(link)).toBe(ROOT)
  })

  it('다른 작성자가 걷고 다시 만들기까지 먼저 했어도(ENOENT 뒤 EEXIST) 성공이다', async () => {
    const f = racing({
      target: 'E:\\옛 자리\\Astera',
      beforeUnlink: (links) => void links.delete(link),
      beforeSymlink: (links) => void links.set(link, ROOT)
    })
    const warnings: ShuttleWarning[] = []
    const l = await sessionCmdLink(
      { publicDir: dir, execPath: EXEC, entryPath: ENTRY, platform: 'win32', env, links: f.api },
      (w) => warnings.push(w)
    )
    expect(warnings).toEqual([])
    expect(l).toEqual({ link, root: ROOT })
  })
})
