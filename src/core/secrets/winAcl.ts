// The Windows half of the secret store's checks (remote runtime design §4.6, DC-12; measured in the Phase 2 plan).
// SIDs, never account names, because `icacls` names are localized. Both tools run from System32 by absolute path:
// `whoami` on PATH can be another program (Git for Windows ships one that rejects `/user`).
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const SYSTEM = new Set(['SY', 'S-1-5-18'])
const system32 = (exe: string): string => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', exe)

/** `icacls <path> /save` writes the entry's name, then its SDDL. */
export function parseIcaclsSave(text: string): string {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l !== '')
  return lines[1] ?? ''
}

/**
 * Why this DACL is not owner-only, or null. The owner is not part of it (ruling M1: `icacls` cannot report it, and
 * an administrator taking ownership is inside the design's threat boundary). A directory must not inherit from its
 * parent; a file inside it may, since what it inherits is the directory's two entries (ruling M2).
 */
export function sddlProblem(sddl: string, userSid: string, o: { dir: boolean }): string | null {
  const m = /^D:([A-Z_]*)((?:\([^)]*\))*)$/.exec(sddl.trim())
  if (!m) return 'no readable access list'
  const flags = m[1]
  if (flags.includes('NO_ACCESS_CONTROL')) return 'a null access list grants everyone'
  if (o.dir && !flags.includes('P')) return 'the directory inherits permissions from its parent'
  for (const ace of m[2].match(/\(([^)]*)\)/g) ?? []) {
    const [type, , , , , sid] = ace.slice(1, -1).split(';')
    if (type !== 'A') return `an access entry of type ${type} for ${sid}`
    if (sid !== userSid && !SYSTEM.has(sid)) return `${sid} has access`
  }
  return null
}

export interface WinAcl {
  userSid(): Promise<string>
  secureDir(dir: string): Promise<void>
  sddlOf(p: string): Promise<string>
}

export function systemWinAcl(): WinAcl {
  let sid: Promise<string> | null = null
  const userSid = (): Promise<string> =>
    (sid ??= run(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true }).then(({ stdout }) => {
      const found = /"(S-1-[0-9-]+)"/.exec(stdout)?.[1]
      if (!found) throw new Error('could not read this user’s SID from whoami')
      return found
    }))
  return {
    userSid,
    secureDir: async (dir) => {
      const me = await userSid()
      await run(system32('icacls.exe'), [dir, '/inheritance:r', '/grant:r', `*${me}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true })
    },
    sddlOf: async (p) => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-acl-'))
      try {
        const out = path.join(tmp, 'acl')
        await run(system32('icacls.exe'), [p, '/save', out], { windowsHide: true })
        return parseIcaclsSave((await fs.readFile(out)).toString('utf16le'))
      } finally {
        await fs.rm(tmp, { recursive: true, force: true })
      }
    }
  }
}
