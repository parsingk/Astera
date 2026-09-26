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
import type { ShuttleWarning } from '../../types'

// The reasons the installer gives when the `.cmd` had to be written raw (the type's own comment says
// what each means). Declared in core/types.ts, which the renderer can read.
export type { ShuttleWarning }

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

/** The folders a Windows user's own paths live under, by the variable that names each. */
const USER_FOLDER_VARS = ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE'] as const
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/

/**
 * A path as the `.cmd` shuttle writes it: **with a user folder that is not ASCII written as its
 * variable** (`%LOCALAPPDATA%\Programs\Astera\Astera.exe`).
 *
 * cmd.exe reads a batch file in the console's OEM code page (949 on Korean Windows, 437 on English),
 * never as UTF-8, so a `C:\Users\홍길동\…` written into the file comes back as other characters and
 * the program is not found (measured 2026-09-26). The executable and the CLI entry both sit under the
 * user's own folder, so for a person whose user name is not ASCII every `astera` from cmd or
 * PowerShell failed. A variable is expanded inside cmd from the environment, which is UTF-16, so the
 * path arrives whole and the file stays ASCII.
 *
 * **Only a path that needs it is touched.** An ASCII path is written exactly as before, so nobody who
 * works today depends on a variable being set. Of the folders that hold the path, the longest whose
 * remainder is ASCII wins; a path with no such folder (a non-ASCII install folder outside the user's
 * own) is written as it is, which is what it was before, unless the installer gave it a junction
 * (`CmdLink` below). Windows compares paths without case, and a folder counts only up to a separator,
 * so `C:\Users\홍` does not claim `C:\Users\홍길동`.
 *
 * `always` writes a user folder as its variable even when the path is ASCII. The junction's paths use
 * it, so the shuttle reads `%LOCALAPPDATA%\astera\app\…` as the design names them.
 */
const forCmd = (p: string, env: NodeJS.ProcessEnv, always = false): string => {
  if (!always && PRINTABLE_ASCII.test(p)) return p
  let best: { name: string; length: number } | null = null
  for (const name of USER_FOLDER_VARS) {
    const value = env[name]?.replace(/[\\/]+$/, '')
    if (!value) continue
    const rest = p.slice(value.length)
    if (p.slice(0, value.length).toLowerCase() !== value.toLowerCase()) continue
    if (rest !== '' && rest[0] !== '\\' && rest[0] !== '/') continue
    if (!PRINTABLE_ASCII.test(rest)) continue
    if (best === null || value.length > best.length) best = { name, length: value.length }
  }
  return best === null ? p : `%${best.name}%${p.slice(best.length)}`
}

/**
 * A directory junction the `.cmd` shuttle reaches the app through: `link` (`%LOCALAPPDATA%\astera\app`,
 * beside the public `bin`) points at `root`, the folder that holds the executable.
 *
 * **Why.** A non-ASCII install folder outside the user's own folders (`D:\프로그램\Astera`) cannot be
 * written as a variable (forCmd), and cmd.exe reads the batch file in the OEM code page, so the raw
 * name breaks. The junction gives the same files an ASCII name. `fs.symlink(root, link, 'junction')`
 * needs no admin. Only the public shuttle gets one: the installer makes it (installShuttle, syncShuttle)
 * and shuttleFiles only writes the paths through it.
 */
export interface CmdLink {
  link: string
  root: string
}

export type CmdLinkPlan =
  | { kind: 'none' }
  | { kind: 'link'; link: CmdLink }
  | { kind: 'unsuitable'; reason: 'entry-outside-root' | 'remainder-not-ascii' }

/** Where the junction lives for a public shuttle in `dir`: `app` beside it. */
export const cmdLinkPath = (dir: string): string => path.win32.join(path.win32.dirname(dir), 'app')

/** `p` below `root` as its remainder (a leading separator, or '' for root itself), or null when it is
 *  not below. Without case and only up to a separator, as forCmd compares. */
const restUnder = (root: string, p: string): string | null => {
  const r = root.replace(/[\\/]+$/, '')
  if (p.slice(0, r.length).toLowerCase() !== r.toLowerCase()) return null
  const rest = p.slice(r.length)
  return rest === '' || rest[0] === '\\' || rest[0] === '/' ? rest : null
}

/**
 * Whether the public `.cmd` shuttle needs the junction (win32 only; pure).
 *
 * `none` when forCmd already leaves both paths printable ASCII. `link` when both paths sit below the
 * executable's folder with ASCII remainders. `unsuitable` otherwise: the shuttle is then written as it
 * always was, raw, and the installer says so.
 */
export function cmdLinkFor(a: {
  dir: string
  execPath: string
  entryPath: string
  env: NodeJS.ProcessEnv
}): CmdLinkPlan {
  if (PRINTABLE_ASCII.test(forCmd(a.execPath, a.env)) && PRINTABLE_ASCII.test(forCmd(a.entryPath, a.env)))
    return { kind: 'none' }
  const root = path.win32.dirname(a.execPath)
  const execRest = restUnder(root, a.execPath)
  const entryRest = restUnder(root, a.entryPath)
  if (execRest === null || entryRest === null) return { kind: 'unsuitable', reason: 'entry-outside-root' }
  const link = cmdLinkPath(a.dir)
  if (
    !PRINTABLE_ASCII.test(execRest) ||
    !PRINTABLE_ASCII.test(entryRest) ||
    !PRINTABLE_ASCII.test(forCmd(link, a.env))
  )
    return { kind: 'unsuitable', reason: 'remainder-not-ascii' }
  return { kind: 'link', link: { link, root } }
}

/** A path as the `.cmd` writes it: through the junction when there is one and the path is below its
 *  root, and as forCmd writes it otherwise. */
const forCmdVia = (p: string, env: NodeJS.ProcessEnv, link: CmdLink | undefined): string => {
  const rest = link ? restUnder(link.root, p) : null
  return link && rest !== null ? forCmd(link.link + rest, env, true) : forCmd(p, env)
}

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
  /** Where the user folders `forCmd` writes as variables are read from. This process's by default. */
  env?: NodeJS.ProcessEnv
  /** The junction the `.cmd` goes through (CmdLink). Only the installer passes one, once it exists. */
  link?: CmdLink
}): ShuttleFile[] {
  if ((a.platform ?? process.platform) === 'win32') {
    const env = a.env ?? process.env
    return [
      {
        name: 'astera.cmd',
        content: `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${forCmdVia(a.execPath, env, a.link)}" "${forCmdVia(a.entryPath, env, a.link)}" %*\r\n`
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

/** The few filesystem calls the junction needs, injected so tests can stand in for them. Node's
 *  `lstat` reports a junction as a symbolic link, and its `unlink` removes a junction itself, never
 *  what it points at. */
export interface LinkFs {
  lstat(p: string): Promise<{ isSymbolicLink(): boolean }>
  readlink(p: string): Promise<string>
  symlink(target: string, p: string, type: 'junction'): Promise<void>
  unlink(p: string): Promise<void>
}

const realLinkFs: LinkFs = {
  lstat: (p) => fs.lstat(p),
  readlink: (p) => fs.readlink(p),
  // %LOCALAPPDATA%\astera may not exist yet when the session shuttle is the first to need the junction.
  symlink: async (target, p, type) => {
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.symlink(target, p, type)
  },
  unlink: (p) => fs.unlink(p)
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A junction target in a form two can be compared in: no `\\?\` or `\??\` prefix, backslashes, no
 *  trailing separator, no case. */
const linkKey = (p: string): string =>
  p
    .replace(/^(\\\\\?\\|\\\?\?\\)/, '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase()

type LinkState = 'missing' | 'other' | { target: string }

const linkState = async (link: string, links: LinkFs): Promise<LinkState> => {
  try {
    if (!(await links.lstat(link)).isSymbolicLink()) return 'other'
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw err
  }
  return { target: await links.readlink(link) }
}

/** Removes the junction if one is there, **as a link only**: a folder or file at that path stays, and
 *  nothing is ever removed through it. Quiet on failure; a stale junction harms nothing. */
const dropLink = async (link: string, links: LinkFs): Promise<void> => {
  try {
    if (typeof (await linkState(link, links)) === 'object') await links.unlink(link)
  } catch {
    /* left as it is */
  }
}

/**
 * The installer's half of the junction (win32, public shuttle only). Makes `%LOCALAPPDATA%\astera\app`
 * point at the install root when the `.cmd` needs it (cmdLinkFor), re-points one left from where the
 * app used to be, and removes one the shuttle no longer needs. Returns the link to write the `.cmd`
 * through, or undefined to write it raw, with a warning when raw is not what it needed.
 */
async function prepareCmdLink(
  a: { dir: string; execPath: string; entryPath: string; env: NodeJS.ProcessEnv; links: LinkFs; keepUnneeded?: boolean },
  warn: (w: ShuttleWarning) => void
): Promise<CmdLink | undefined> {
  const plan = cmdLinkFor(a)
  const linkPath = cmdLinkPath(a.dir)
  if (plan.kind !== 'link') {
    if (plan.kind === 'unsuitable')
      warn({
        code: 'junction-unsuitable',
        detail:
          plan.reason === 'entry-outside-root'
            ? `the CLI entry ${a.entryPath} is not inside ${path.win32.dirname(a.execPath)}`
            : `the paths below ${path.win32.dirname(a.execPath)} are not ASCII either`
      })
    if (!a.keepUnneeded) await dropLink(linkPath, a.links)
    return undefined
  }
  const { link, root } = plan.link
  try {
    const state = await linkState(link, a.links)
    if (state === 'other') {
      warn({ code: 'link-path-taken', detail: `${link} exists and is not a junction; it was left alone` })
      return undefined
    }
    if (state !== 'missing') {
      if (linkKey(state.target) === linkKey(root)) return plan.link
      await a.links.unlink(link) // the app moved: this junction still names its old folder
    }
    await a.links.symlink(root, link, 'junction')
    return plan.link
  } catch (err) {
    warn({ code: 'junction-failed', detail: `could not make the junction ${link} -> ${root}: ${errText(err)}` })
    return undefined
  }
}

/** 깔려 있는 공개 셔틀을 지금의 앱으로 다시 쓴다. 판단은 shuttleSyncPlan 이 하고, 쓰는 것은
 *  `rewrite` 일 때뿐이다. PATH 도 셸 프로필도 건드리지 않는다.
 *
 *  win32 에서는 `.cmd` 가 정션(CmdLink)을 거쳐야 하는지도 본다. **깔려 있고 우리 것일 때만** 정션을
 *  만들거나 지금의 설치 폴더로 다시 가리키게 한다. 앱이 옮겨 가도 설치 폴더 아래의 나머지가 같으면
 *  셔틀은 한 글자도 바뀌지 않으므로(`current`), 정션의 대상은 셔틀과 따로 확인한다. 정션을 못 만든
 *  까닭은 `onWarning` 으로 넘긴다. */
export async function syncShuttle(a: {
  dir: string
  execPath: string
  entryPath: string
  appImage?: AppImageLaunch
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  links?: LinkFs
  onWarning?: (w: ShuttleWarning) => void
}): Promise<ShuttleSyncPlan> {
  const first = shuttleFiles(a)
  const current: Record<string, string | null> = {}
  for (const f of first) current[f.name] = await readOrNull(path.join(a.dir, f.name))
  const installed = shuttleSyncPlan({ current, desired: first })
  if (installed === 'not-installed' || installed === 'foreign') return installed
  const link =
    (a.platform ?? process.platform) === 'win32'
      ? await prepareCmdLink(
          { ...a, env: a.env ?? process.env, links: a.links ?? realLinkFs },
          a.onWarning ?? (() => {})
        )
      : undefined
  const desired = shuttleFiles({ ...a, link })
  const plan = shuttleSyncPlan({ current, desired })
  if (plan === 'rewrite') await writeShuttle({ ...a, link })
  return plan
}

/**
 * 공개 셔틀을 걷는다. **우리가 쓴 파일만 지운다.** 이름이 같아도 내용이 우리 모양이 아니면 두고,
 * 폴더는 비어도 지우지 않는다(`%LOCALAPPDATA%\astera` 는 다른 것도 사는 폴더이고, `~/.local/bin` 은
 * 말할 것도 없다). 지운 이름들을 돌려준다.
 *
 * win32 에서는 `.cmd` 가 거치던 정션(`%LOCALAPPDATA%\astera\app`)도 걷는다. **정션일 때만, 링크로만**
 * 지우고 그 안으로 들어가지 않는다. 남의 `astera.cmd` 가 남아 있으면 그것이 쓰고 있을지 모르니 둔다.
 */
export async function removeShuttle(a: {
  dir: string
  platform?: NodeJS.Platform
  links?: LinkFs
  /** The running app's own paths. While its session shuttle needs the junction (cmdLinkFor says
   *  `link`), the junction stays: that shuttle goes through it for as long as this app runs. */
  keepFor?: { execPath: string; entryPath: string; env?: NodeJS.ProcessEnv }
}): Promise<string[]> {
  const removed: string[] = []
  for (const name of shuttleNames(a.platform)) {
    const p = path.join(a.dir, name)
    const content = await readOrNull(p)
    if (content === null || !isShuttleContent(name, content)) continue
    await fs.rm(p, { force: true })
    removed.push(name)
  }
  const sessionNeedsIt =
    a.keepFor !== undefined &&
    cmdLinkFor({ dir: a.dir, ...a.keepFor, env: a.keepFor.env ?? process.env }).kind === 'link'
  if (
    (a.platform ?? process.platform) === 'win32' &&
    !sessionNeedsIt &&
    (await readOrNull(path.join(a.dir, 'astera.cmd'))) === null
  )
    await dropLink(cmdLinkPath(a.dir), a.links ?? realLinkFs)
  return removed
}

/**
 * The junction for the app's **session** shuttle (`<userData>\orch`, written by bootOrch and by the
 * Host's ensureShuttle). The same junction as the public shuttle's, beside `publicDir`, and the same
 * decision (cmdLinkFor). It is made or re-pointed here, **never removed**: the public shuttle may be
 * using it, and only the public uninstall and the NSIS uninstaller take it away. Returns the link to
 * write the `.cmd` through, or undefined to write it raw; a raw path it needed is a warning.
 *
 * Both writers of that file call this, so they write the same `.cmd` and neither undoes the other.
 */
export async function sessionCmdLink(
  a: {
    publicDir: string
    execPath: string
    entryPath: string
    platform?: NodeJS.Platform
    env?: NodeJS.ProcessEnv
    links?: LinkFs
  },
  warn: (w: ShuttleWarning) => void
): Promise<CmdLink | undefined> {
  if ((a.platform ?? process.platform) !== 'win32') return undefined
  return prepareCmdLink(
    {
      dir: a.publicDir,
      execPath: a.execPath,
      entryPath: a.entryPath,
      env: a.env ?? process.env,
      links: a.links ?? realLinkFs,
      keepUnneeded: true
    },
    warn
  )
}

/**
 * 공개 셔틀을 까는 버튼의 일. writeShuttle 에 win32 의 정션(CmdLink)을 더한다: `.cmd` 가 정션을
 * 거쳐야 하면 만들고(예전 것은 다시 가리키게), 못 만들면 지금처럼 진짜 경로를 적고 `warnings` 로
 * 까닭을 돌려준다. 돌려주는 `path` 는 정본이다.
 */
export async function installShuttle(a: {
  dir: string
  execPath: string
  entryPath: string
  appImage?: AppImageLaunch
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  links?: LinkFs
}): Promise<{ path: string; warnings: ShuttleWarning[] }> {
  const warnings: ShuttleWarning[] = []
  let link: CmdLink | undefined
  if ((a.platform ?? process.platform) === 'win32') {
    await fs.mkdir(a.dir, { recursive: true }) // the junction goes beside it
    link = await prepareCmdLink({ ...a, env: a.env ?? process.env, links: a.links ?? realLinkFs }, (w) =>
      warnings.push(w)
    )
  }
  return { path: await writeShuttle({ ...a, link }), warnings }
}

export async function writeShuttle(a: {
  dir: string
  execPath: string
  entryPath: string
  appImage?: AppImageLaunch
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  link?: CmdLink
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
export async function ensureShuttle(a: {
  dir: string
  execPath: string
  entryPath: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** The junction the `.cmd` goes through (sessionCmdLink), the same one the app's writer uses. */
  link?: CmdLink
}): Promise<string> {
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
