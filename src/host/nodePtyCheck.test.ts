import { describe, it, expect } from 'vitest'
import { nodePtyMissing, CONOUT_WORKER } from './nodePtyCheck'

const LIB = 'C:\\Users\\x\\AppData\\Local\\astera\\host-runtime\\node-24.15.0\\node_modules\\node-pty\\lib'
const has =
  (...present: string[]) =>
  (p: string): boolean =>
    present.includes(p)

describe('nodePtyMissing', () => {
  it('names the conout worker when it is not there', () => {
    expect(nodePtyMissing({ platform: 'win32', libDir: LIB, exists: has() })).toBe(`${LIB}\\${CONOUT_WORKER}`)
  })

  it('is null when it is there', () => {
    expect(nodePtyMissing({ platform: 'win32', libDir: LIB, exists: has(`${LIB}\\${CONOUT_WORKER}`) })).toBeNull()
  })

  // The file only exists for the Windows ConPTY path — `unixTerminal.js` starts no worker thread and
  // has nothing that can go half-missing this way.
  it('checks nothing off win32', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(nodePtyMissing({ platform, libDir: '/opt/app/node_modules/node-pty/lib', exists: has() })).toBeNull()
    }
  })

  // The caller resolves `libDir` from node-pty itself and cannot always get an answer — inside an
  // asar, or with a resolution this build did not anticipate. Refusing every spawn on that would be
  // far worse than the failure this guards against, which is rare and repairs itself (design F6).
  it('checks nothing when the caller could not locate node-pty', () => {
    expect(nodePtyMissing({ platform: 'win32', libDir: null, exists: has() })).toBeNull()
  })

  // A filesystem that throws on the check is not evidence the file is missing.
  it('checks nothing when the filesystem refuses to answer', () => {
    expect(
      nodePtyMissing({
        platform: 'win32',
        libDir: LIB,
        exists: () => {
          throw new Error('EPERM')
        }
      })
    ).toBeNull()
  })
})
