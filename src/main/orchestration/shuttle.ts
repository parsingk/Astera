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
 * The shuttle files for this platform. **The first element is the canonical one that `ASTERA_CLI`
 * points at** — on win32 that is the `.cmd`, because it resolves reliably from PowerShell and cmd,
 * and those are the shells that need the absolute path from the environment variable. The sh shuttle
 * is the second file, there to make `astera` resolve under bash.
 */
export function shuttleFiles(a: { execPath: string; entryPath: string }): ShuttleFile[] {
  if (process.platform === 'win32') {
    return [
      {
        name: 'astera.cmd',
        content: `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${a.execPath}" "${a.entryPath}" %*\r\n`
      },
      shShuttle(a)
    ]
  }
  return [shShuttle(a)]
}

export async function writeShuttle(a: {
  dir: string
  execPath: string
  entryPath: string
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

export async function writeInfo(a: {
  dir: string
  port: number
  token: string
}): Promise<string> {
  await fs.mkdir(a.dir, { recursive: true })
  const p = path.join(a.dir, 'orch-info.json')
  // OS file permissions on the token file are what enforce access control.
  await fs.writeFile(p, JSON.stringify({ port: a.port, token: a.token }), {
    encoding: 'utf8',
    mode: 0o600
  })
  return p
}
