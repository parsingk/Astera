// The higgsfield names an agent types, answered by Astera inside its own sessions (higgsfield accounts
// design §2). Each shim hands its arguments to the `astera` shuttle beside it as `astera hf-proxy …`.
// They live only in the session shuttle folder (<profile>/orch), which terminal and chat sessions put
// first on PATH; a shell Astera did not start never sees them.
import path from 'node:path'

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
