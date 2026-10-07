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
 * SDDL writes a few accounts by alias instead of SID: the built-in Administrator (RID 500) as LA and Guest (RID 501) as
 * LG. Measured on the GitHub Windows runner, whose user is the built-in Administrator.
 */
const isUser = (sid: string, userSid: string): boolean =>
  sid === userSid || (sid === 'LA' && userSid.endsWith('-500')) || (sid === 'LG' && userSid.endsWith('-501'))

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
    if (!isUser(sid, userSid) && !SYSTEM.has(sid)) return `${sid} has access`
  }
  return null
}

export interface WinAcl {
  userSid(): Promise<string>
  secureDir(dir: string): Promise<void>
  sddlOf(p: string): Promise<string>
}

/** SIDs for the well-known aliases SDDL writes instead of them, so they can be named to `icacls /remove`. An alias not
 *  here is left alone, and the read check then refuses the folder: it fails closed. */
const ALIAS_SID: Record<string, string> = {
  WD: 'S-1-1-0',
  CO: 'S-1-3-0',
  CG: 'S-1-3-1',
  OW: 'S-1-3-4',
  NU: 'S-1-5-2',
  IU: 'S-1-5-4',
  SU: 'S-1-5-6',
  AN: 'S-1-5-7',
  PS: 'S-1-5-10',
  AU: 'S-1-5-11',
  RC: 'S-1-5-12',
  LS: 'S-1-5-19',
  NS: 'S-1-5-20',
  BA: 'S-1-5-32-544',
  BU: 'S-1-5-32-545',
  BG: 'S-1-5-32-546',
  PU: 'S-1-5-32-547',
  RD: 'S-1-5-32-555',
  AC: 'S-1-15-2-1'
}

/** Every SID other than this user and SYSTEM that an entry in this DACL names, each once. */
export function othersIn(sddl: string, userSid: string): string[] {
  const out = new Set<string>()
  for (const ace of sddl.match(/\(([^)]*)\)/g) ?? []) {
    const sid = ace.slice(1, -1).split(';')[5]
    if (!sid || isUser(sid, userSid) || SYSTEM.has(sid)) continue
    const resolved = sid.startsWith('S-') ? sid : ALIAS_SID[sid]
    if (resolved) out.add(resolved)
  }
  return [...out]
}

const sddlOf = async (p: string): Promise<string> => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-acl-'))
  try {
    const out = path.join(tmp, 'acl')
    await run(system32('icacls.exe'), [p, '/save', out], { windowsHide: true })
    return parseIcaclsSave((await fs.readFile(out)).toString('utf16le'))
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
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
    // Removing inheritance and granting two entries is not enough: a new folder can carry explicit entries of its own
    // (the GitHub runner's Temp gives every new folder an explicit Administrators entry, measured 2026-10-07), and
    // `/inheritance:r` keeps those. So whatever else the folder still lists is removed by SID afterwards. `/restore`
    // would write the whole list in one step, but it needs a privilege an ordinary user does not hold.
    secureDir: async (dir) => {
      const me = await userSid()
      await run(system32('icacls.exe'), [dir, '/inheritance:r', '/grant:r', `*${me}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true })
      const extra = othersIn(await sddlOf(dir), me)
      if (extra.length > 0) await run(system32('icacls.exe'), [dir, '/remove', ...extra.map((x) => `*${x}`)], { windowsHide: true })
    },
    sddlOf
  }
}
