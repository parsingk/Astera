// The higgsfield names an agent types, answered by Astera inside its own sessions (higgsfield accounts
// design §2). Each shim hands its arguments to the `astera` shuttle beside it as `astera hf-proxy …`.
// They live only in the session shuttle folder (<profile>/orch), which terminal and chat sessions put
// first on PATH; a shell Astera did not start never sees them.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { findOnWindowsPath } from '../sessions/windowsExecutable'

export const HF_NAMES = ['higgsfield', 'hf', 'higgs'] as const
const MARK = 'astera" hf-proxy'

/** Each shim says which name it was invoked by (`--as=<name>`), so the proxy looks that name up first
 *  and can tell the Higgsfield `hf` from another CLI of the same name (Hugging Face's). */
export function hfShimFiles(platform: NodeJS.Platform): { name: string; content: string }[] {
  const sh = (name: string) => ({ name, content: `#!/bin/sh\nexec "$(dirname "$0")/astera" hf-proxy --as=${name} "$@"\n` })
  if (platform !== 'win32') return HF_NAMES.map(sh)
  return HF_NAMES.flatMap((n) => [
    { name: `${n}.cmd`, content: `@echo off\r\n"%~dp0astera.cmd" hf-proxy --as=${n} %*\r\n` },
    sh(n)
  ])
}

export const isHfShim = (content: string): boolean => content.includes(MARK) || content.includes('astera.cmd" hf-proxy')

/** The real CLI: the first `higgsfield` (then `hf`, then `higgs`) on PATH whose file is not one of our
 *  shims and whose folder is not in `skipDirs`. Every shim folder is skipped by content, so a PATH that
 *  holds two profiles' orch folders cannot send the proxy back into itself.
 *  `prefer`: the name the shim was invoked by, looked up first; the other names follow only when it is
 *  one of ours. `accept`: a found file it returns false for is passed over and the search goes on. */
export function findRealHiggsfield(a: {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  skipDirs: string[]
  read: (p: string) => string | null
  prefer?: string
  accept?: (file: string) => boolean
}): string | null {
  const p = a.platform === 'win32' ? path.win32 : path.posix
  const key = Object.keys(a.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const dirs = (a.env[key] ?? '').split(a.platform === 'win32' ? ';' : ':').filter(Boolean)
  const exts = a.platform === 'win32'
    ? (a.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())
    : ['']
  const skip = new Set(a.skipDirs.map((d) => p.resolve(d).toLowerCase()))
  const names: readonly string[] = a.prefer === undefined
    ? HF_NAMES
    : (HF_NAMES as readonly string[]).includes(a.prefer) ? [a.prefer, ...HF_NAMES.filter((n) => n !== a.prefer)] : [a.prefer]
  for (const name of names) {
    for (const dir of dirs) {
      if (skip.has(p.resolve(dir).toLowerCase())) continue
      for (const ext of exts) {
        const file = p.join(dir, name + ext)
        const content = a.read(file)
        if (content === null) continue
        if (isHfShim(content)) break
        if (a.accept && !a.accept(file)) break
        return file
      }
    }
  }
  return null
}

/** The script an npm-generated `.cmd` shim runs, or null when the file is not shaped like one. */
export function npmShimScript(cmdFile: string, read: (p: string) => string | null): string | null {
  const text = read(cmdFile)
  if (text === null) return null
  const m = /"%_prog%"\s+"([^"\r\n]*)"\s+%\*/i.exec(text)
  if (!m) return null
  const script = path.win32.normalize(m[1].replace(/%~dp0%?|%dp0%/gi, path.win32.dirname(cmdFile)))
  return script.includes('%') ? null : script
}

const IN_HIGGSFIELD = /[\\/]@higgsfield[\\/]/i

/** Whether `file` is the Higgsfield CLI (the npm package `@higgsfield/cli`) and not another program of
 *  the same name, such as Hugging Face's `hf`. win32: an npm `.cmd` whose script is inside
 *  `@higgsfield`, or a file whose real path is; POSIX: the symlink's real path. */
export function isHiggsfieldCli(
  file: string,
  platform: NodeJS.Platform,
  deps: { read?: (p: string) => string | null; realpath?: (p: string) => string } = {}
): boolean {
  const realpath = deps.realpath ?? realpathSync.native
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const script = npmShimScript(file, deps.read ?? ((p) => { try { return readFileSync(p, 'utf8') } catch { return null } }))
    if (script !== null && IN_HIGGSFIELD.test(script)) return true
  }
  try {
    return IN_HIGGSFIELD.test(realpath(file))
  } catch {
    return false
  }
}

/** What an npm-generated `.cmd` shim runs: `"%_prog%" "%dp0%\node_modules\…\x.js" %*`. Parsing it lets
 *  the proxy start node on the script directly, so no cmd.exe reads the agent's words (a prompt with
 *  `&`, `%` or `^` would otherwise be syntax). `node` is the node.exe beside the shim, else `node` on
 *  PATH, else this process's own executable run as node (`electronAsNode`: set ELECTRON_RUN_AS_NODE=1).
 *  null when the file is not shaped like an npm shim. */
export function npmShimTarget(
  cmdFile: string,
  read: (p: string) => string | null,
  opts: { exists?: (p: string) => boolean; env?: NodeJS.ProcessEnv; selfExecPath?: string } = {}
): { node: string; script: string; electronAsNode: boolean } | null {
  const script = npmShimScript(cmdFile, read)
  if (script === null) return null
  const dir = path.win32.dirname(cmdFile)
  const exists = opts.exists ?? existsSync
  const beside = path.win32.join(dir, 'node.exe')
  if (exists(beside)) return { node: beside, script, electronAsNode: false }
  // Only a real .exe: a node.cmd/node.bat (version-manager shim) cannot be spawned without a shell.
  const onPath = findOnWindowsPath('node.exe', opts.env ?? process.env, exists)
  if (onPath) return { node: onPath, script, electronAsNode: false }
  return { node: opts.selfExecPath ?? process.execPath, script, electronAsNode: true }
}
