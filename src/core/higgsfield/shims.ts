// The higgsfield names an agent types, answered by Astera inside its own sessions (higgsfield accounts
// design §2). Each shim hands its arguments to the `astera` shuttle beside it as `astera hf-proxy …`.
// They live only in the session shuttle folder (<profile>/orch), which terminal and chat sessions put
// first on PATH; a shell Astera did not start never sees them.
import path from 'node:path'
import { findOnWindowsPath } from '../sessions/windowsExecutable'

export const HF_NAMES = ['higgsfield', 'hf', 'higgs'] as const
const MARK = 'astera" hf-proxy'

export function hfShimFiles(platform: NodeJS.Platform): { name: string; content: string }[] {
  const sh = (name: string) => ({ name, content: '#!/bin/sh\nexec "$(dirname "$0")/astera" hf-proxy "$@"\n' })
  if (platform !== 'win32') return HF_NAMES.map(sh)
  return HF_NAMES.flatMap((n) => [
    { name: `${n}.cmd`, content: '@echo off\r\n"%~dp0astera.cmd" hf-proxy %*\r\n' },
    sh(n)
  ])
}

export const isHfShim = (content: string): boolean => content.includes(MARK) || content.includes('astera.cmd" hf-proxy')

/** The real CLI: the first `higgsfield` (then `hf`, then `higgs`) on PATH whose file is not one of our
 *  shims and whose folder is not in `skipDirs`. Every shim folder is skipped by content, so a PATH that
 *  holds two profiles' orch folders cannot send the proxy back into itself. */
export function findRealHiggsfield(a: {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  skipDirs: string[]
  read: (p: string) => string | null
}): string | null {
  const p = a.platform === 'win32' ? path.win32 : path.posix
  const key = Object.keys(a.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const dirs = (a.env[key] ?? '').split(a.platform === 'win32' ? ';' : ':').filter(Boolean)
  const exts = a.platform === 'win32'
    ? (a.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())
    : ['']
  const skip = new Set(a.skipDirs.map((d) => p.resolve(d).toLowerCase()))
  for (const name of HF_NAMES) {
    for (const dir of dirs) {
      if (skip.has(p.resolve(dir).toLowerCase())) continue
      for (const ext of exts) {
        const file = p.join(dir, name + ext)
        const content = a.read(file)
        if (content === null) continue
        if (isHfShim(content)) break
        return file
      }
    }
  }
  return null
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
  const text = read(cmdFile)
  if (text === null) return null
  const m = /"%_prog%"\s+"([^"\r\n]*)"\s+%\*/i.exec(text)
  if (!m) return null
  const dir = path.win32.dirname(cmdFile)
  const script = path.win32.normalize(m[1].replace(/%~dp0%?|%dp0%/gi, dir))
  if (script.includes('%')) return null
  const exists = opts.exists ?? ((p: string) => read(p) !== null)
  const beside = path.win32.join(dir, 'node.exe')
  if (exists(beside)) return { node: beside, script, electronAsNode: false }
  const onPath = findOnWindowsPath('node', opts.env ?? process.env, exists)
  if (onPath) return { node: onPath, script, electronAsNode: false }
  return { node: opts.selfExecPath ?? process.execPath, script, electronAsNode: true }
}
