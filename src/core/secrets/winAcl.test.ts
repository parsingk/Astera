import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { parseIcaclsSave, sddlProblem, systemWinAcl } from './winAcl'

const ME = 'S-1-5-21-1-2-3-1001'

describe('parseIcaclsSave', () => {
  it('takes the SDDL line of icacls /save output (name, then SDDL)', () => {
    expect(parseIcaclsSave('\uFEFFf\r\nD:AI(A;ID;FA;;;SY)\r\n')).toBe('D:AI(A;ID;FA;;;SY)')
  })
})

describe('sddlProblem (remote runtime design §4.6, DC-12)', () => {
  it('accepts a protected directory and an inheriting file with only the user and SYSTEM', () => {
    expect(sddlProblem(`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${ME})`, ME, { dir: true })).toBeNull()
    expect(sddlProblem(`D:AI(A;ID;FA;;;SY)(A;ID;FA;;;${ME})`, ME, { dir: false })).toBeNull()
    expect(sddlProblem(`D:PAI(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;${ME})`, ME, { dir: true })).toBeNull()
  })
  it('refuses a directory whose DACL is not protected', () => {
    expect(sddlProblem(`D:AI(A;OICI;FA;;;${ME})`, ME, { dir: true })).toMatch(/inherits/)
  })
  it('refuses any other SID with any right, including write without read', () => {
    expect(sddlProblem(`D:AI(A;;0x100116;;;BU)(A;ID;FA;;;${ME})`, ME, { dir: false })).toMatch(/BU/)
    expect(sddlProblem(`D:AI(A;ID;FA;;;BA)(A;ID;FA;;;${ME})`, ME, { dir: false })).toMatch(/BA/)
  })
  it('refuses a deny ACE, a null DACL, and text that is no DACL', () => {
    expect(sddlProblem(`D:P(D;;FA;;;WD)(A;;FA;;;${ME})`, ME, { dir: true })).not.toBeNull()
    expect(sddlProblem('D:NO_ACCESS_CONTROL', ME, { dir: false })).not.toBeNull()
    expect(sddlProblem('', ME, { dir: false })).not.toBeNull()
  })
})

describe.runIf(process.platform === 'win32')('systemWinAcl on this machine', () => {
  it('secures a directory to the user and SYSTEM, and catches a write-only grant to Users (Review Focus 3, 5)', async () => {
    const acl = systemWinAcl()
    const me = await acl.userSid()
    expect(me).toMatch(/^S-1-5-21-/)
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-winacl-'))
    try {
      const dir = path.join(base, 'remote')
      await fs.mkdir(dir)
      expect(sddlProblem(await acl.sddlOf(dir), me, { dir: true })).not.toBeNull()
      await acl.secureDir(dir)
      expect(sddlProblem(await acl.sddlOf(dir), me, { dir: true })).toBeNull()
      const f = path.join(dir, 'clients.json')
      await fs.writeFile(f, '{}', { flag: 'wx', mode: 0o600 })
      expect(sddlProblem(await acl.sddlOf(f), me, { dir: false })).toBeNull()
      execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [f, '/grant', '*S-1-5-32-545:(W)'])
      expect(sddlProblem(await acl.sddlOf(f), me, { dir: false })).toMatch(/BU/)
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })
})
