// Generates the CLI shuttle scripts.
// Rather than shipping a separate node binary, this reuses Electron itself with
// ELECTRON_RUN_AS_NODE=1. The executable path depends on where the app was installed, so it cannot
// be baked in at build time and the shuttle is written at runtime instead.
//
// **win32 needs two files** (found by testing): MSYS bash — the shell the Bash tool of claude and
// codex uses on win32 — does not apply PATHEXT, so `astera` fails to resolve `astera.cmd` and comes
// back as command not found. Shipping an extension-less sh shuttle alongside it gives bash something
// to find. cmd and PowerShell keep resolving the `.cmd` through PATHEXT, so the two never collide
// (neither treats an extension-less file as executable). It is the same pattern npm uses when it
// ships both `npm` and `npm.cmd`.
import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface ShuttleFile {
  name: string
  content: string
}

/** Path as handed to sh. Backslashes become forward slashes so sh's quoting rules (where `\` is the
 *  escape character) cannot bite — both the Windows API and MSYS accept the `C:/...` form. This is a
 *  no-op for posix paths. */
const forSh = (p: string): string => p.replace(/\\/g, '/')

const shShuttle = (a: { execPath: string; entryPath: string }): ShuttleFile => ({
  name: 'astera',
  content: `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${forSh(a.execPath)}" "${forSh(a.entryPath)}" "$@"\n`
})

/**
 * How the public shuttle reaches the app when the app is a Linux AppImage.
 *
 * `path` is the AppImage file itself (`$APPIMAGE`). `entryInMount` is where the CLI bundle sits inside
 * the image, relative to its root. Both are chosen by `appImageLaunchFor` (cliInstall.ts).
 */
export interface AppImageLaunch {
  path: string
  entryInMount: string
}

/**
 * The script run in place of the CLI entry when the shuttle goes through an AppImage.
 *
 * Running the AppImage mounts it afresh under a new `/tmp/.mount_*` name and hands that name to the
 * process as `$APPDIR`, so the entry can only be found from inside that process. This script does
 * that and then makes `process.argv` look like a plain `node cli.js ...` run: the shuttle passes a
 * placeholder (`astera`) and a `--no-sandbox` after `-e` (appImageShuttle says why), and both are
 * replaced by the entry path, which is what the CLI reads as `argv[1]`.
 */
export const appImageBootstrap = (entryInMount: string): string =>
  `var p=process.env.APPDIR+${JSON.stringify(`/${entryInMount.replace(/\\/g, '/').replace(/^\/+/, '')}`)};` +
  `process.argv.splice(1,2,p);require(p)`

/** A string as one single-quoted sh word. */
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * The shuttle that runs the CLI through an AppImage.
 *
 * `process.execPath` of an AppImage is its temporary mount, which is gone once the app quits, so the
 * shuttle calls the AppImage file instead. That goes through the image's AppRun, which passes the
 * environment (ELECTRON_RUN_AS_NODE) and the arguments on to the Electron binary.
 *
 * **The `--no-sandbox` is there because of AppRun.** electron-builder's AppRun puts `--no-sandbox` in
 * front of the arguments when unprivileged user namespaces are unavailable, unless the arguments
 * already contain one. Node mode does not know that flag and would refuse to start. Placed after the
 * `-e` script it is a script argument, AppRun sees it and adds nothing, and the bootstrap removes it.
 */
const appImageShuttle = (a: AppImageLaunch): ShuttleFile => ({
  name: 'astera',
  content:
    `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${a.path}" -e ${shQuote(appImageBootstrap(a.entryInMount))}` +
    ` astera --no-sandbox "$@"\n`
})

/**
 * The shuttle files for this platform. **The first element is the canonical one that `ASTERA_CLI`
 * points at** — on win32 that is the `.cmd`, because it resolves reliably from PowerShell and cmd,
 * and those are the shells that need the absolute path from the environment variable. The sh shuttle
 * is the second file, there to make `astera` resolve under bash.
 *
 * `appImage` is for the public shuttle only, and only off win32: the session shuttle lives exactly as
 * long as the running app, whose mount is alive for all of that time.
 */
export function shuttleFiles(a: {
  execPath: string
  entryPath: string
  appImage?: AppImageLaunch
  platform?: NodeJS.Platform
}): ShuttleFile[] {
  if ((a.platform ?? process.platform) === 'win32') {
    return [
      {
        name: 'astera.cmd',
        content: `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${a.execPath}" "${a.entryPath}" %*\r\n`
      },
      shShuttle(a)
    ]
  }
  return [a.appImage ? appImageShuttle(a.appImage) : shShuttle(a)]
}

/** 이 플랫폼이 쓰는 셔틀 파일의 이름들. "설치되어 있는가" 를 묻는 자리가 이것만
 *  필요하고, 그 자리에 가짜 경로를 넣어 shuttleFiles 를 부르게 하지 않는다. */
export const shuttleNames = (platform: NodeJS.Platform = process.platform): string[] =>
  shuttleFiles({ execPath: '', entryPath: '', platform }).map((f) => f.name)

/**
 * 이 파일이 우리가 쓴 셔틀인가.
 *
 * 공개 셔틀이 사는 폴더(`~/.local/bin`, `%LOCALAPPDATA%\astera\bin`)는 사람이 PATH 에 넣은 폴더라
 * 남의 파일도 산다. 지우거나 다시 쓰기 전에 묻는 질문이 이것이다. 표식을 따로 두지 않고 모양으로
 * 가린다: 지금까지 깔린 셔틀에는 표식이 없고, 그것들도 알아봐야 한다. 모양은 shuttleFiles 가 쓰는
 * 세 가지 그대로이고, 한 글자라도 덧붙었으면 사람의 파일로 본다.
 */
export function isShuttleContent(name: string, content: string): boolean {
  if (name === 'astera.cmd')
    return /^@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"[^"\r\n]*" "[^"\r\n]*" %\*\r\n$/.test(content)
  if (name === 'astera')
    return (
      /^#!\/bin\/sh\nELECTRON_RUN_AS_NODE=1 exec "[^"\n]*" "[^"\n]*" "\$@"\n$/.test(content) ||
      /^#!\/bin\/sh\nELECTRON_RUN_AS_NODE=1 exec "[^"\n]*" -e '[^\n]*' astera --no-sandbox "\$@"\n$/.test(content)
    )
  return false
}

export type ShuttleSyncPlan = 'not-installed' | 'foreign' | 'current' | 'rewrite'

/**
 * 부팅 때 공개 셔틀을 어떻게 할지 (명세 §30).
 *
 * 앱이 새 자리로 옮겨 가면(업데이트, 다른 폴더에 다시 설치, 옮긴 AppImage) 깔아 둔 셔틀은 예전 실행
 * 파일을 가리킨다. 그것을 다시 쓰는 것은 되지만, **깔려 있지 않던 것을 까는 것은 안 된다.** 설치는
 * 사람이 버튼으로 하는 일이다. 그래서 파일이 하나라도 없으면 설치되지 않은 것이고, 남의 파일이
 * 하나라도 있으면 손대지 않는다.
 *
 * `current` 는 이름마다 지금 파일의 내용이고, 없으면 null 이다.
 */
export function shuttleSyncPlan(a: {
  current: Record<string, string | null>
  desired: ShuttleFile[]
}): ShuttleSyncPlan {
  const now = a.desired.map((f) => ({ f, content: a.current[f.name] ?? null }))
  if (now.some((x) => x.content === null)) return 'not-installed'
  if (now.some((x) => !isShuttleContent(x.f.name, x.content ?? ''))) return 'foreign'
  return now.every((x) => x.content === x.f.content) ? 'current' : 'rewrite'
}

const readOrNull = async (p: string): Promise<string | null> => {
  try {
    return await fs.readFile(p, 'utf8')
  } catch {
    return null
  }
}

/** 깔려 있는 공개 셔틀을 지금의 앱으로 다시 쓴다. 판단은 shuttleSyncPlan 이 하고, 쓰는 것은
 *  `rewrite` 일 때뿐이다. PATH 도 셸 프로필도 건드리지 않는다. */
export async function syncShuttle(a: {
  dir: string
  execPath: string
  entryPath: string
  appImage?: AppImageLaunch
  platform?: NodeJS.Platform
}): Promise<ShuttleSyncPlan> {
  const desired = shuttleFiles(a)
  const current: Record<string, string | null> = {}
  for (const f of desired) current[f.name] = await readOrNull(path.join(a.dir, f.name))
  const plan = shuttleSyncPlan({ current, desired })
  if (plan === 'rewrite') await writeShuttle(a)
  return plan
}

/**
 * 공개 셔틀을 걷는다. **우리가 쓴 파일만 지운다.** 이름이 같아도 내용이 우리 모양이 아니면 두고,
 * 폴더는 비어도 지우지 않는다(`%LOCALAPPDATA%\astera` 는 다른 것도 사는 폴더이고, `~/.local/bin` 은
 * 말할 것도 없다). 지운 이름들을 돌려준다.
 */
export async function removeShuttle(a: { dir: string; platform?: NodeJS.Platform }): Promise<string[]> {
  const removed: string[] = []
  for (const name of shuttleNames(a.platform)) {
    const p = path.join(a.dir, name)
    const content = await readOrNull(p)
    if (content === null || !isShuttleContent(name, content)) continue
    await fs.rm(p, { force: true })
    removed.push(name)
  }
  return removed
}

export async function writeShuttle(a: {
  dir: string
  execPath: string
  entryPath: string
  appImage?: AppImageLaunch
  platform?: NodeJS.Platform
}): Promise<string> {
  const files = shuttleFiles(a)
  await fs.mkdir(a.dir, { recursive: true })
  const written: string[] = []
  for (const f of files) {
    const p = path.join(a.dir, f.name)
    await fs.writeFile(p, f.content, 'utf8')
    // **Called on win32 too.** Windows has no execute bit, so Node's chmod only touches the
    // read-only flag and the call is effectively a no-op there — what makes MSYS/Cygwin treat the
    // file as executable is the leading `#!`. The platform branch is omitted because the call is
    // required on posix and harmless on win32 (a branch here would eventually be read backwards).
    await fs.chmod(p, 0o755)
    written.push(p)
  }
  return written[0]
}

/** writeShuttle, but a file whose content is already right is left alone (R6). The Host calls this at
 *  its first spawn and the app writes the same files at its start, so a rewrite of identical content
 *  would be a second writer racing the first for nothing. Returns the canonical path. */
export async function ensureShuttle(a: { dir: string; execPath: string; entryPath: string }): Promise<string> {
  const files = shuttleFiles(a)
  await fs.mkdir(a.dir, { recursive: true })
  const written: string[] = []
  for (const f of files) {
    const p = path.join(a.dir, f.name)
    let current: string | null = null
    try {
      current = await fs.readFile(p, 'utf8')
    } catch {
      /* no file yet, or unreadable: write it */
    }
    if (current !== f.content) {
      await fs.writeFile(p, f.content, 'utf8')
      await fs.chmod(p, 0o755) // the reason is on writeShuttle
    }
    written.push(p)
  }
  return written[0]
}
