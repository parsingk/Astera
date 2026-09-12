import { describe, it, expect } from 'vitest'
import { attachmentNameOf } from './attachmentName'

const at = new Date(2026, 8, 12, 19, 45, 3) // 2026-09-12 19:45:03

describe('attachmentNameOf', () => {
  it('keeps the name something arrived with, and stamps it', () => {
    expect(attachmentNameOf('diagram.png', 'image/png', at, 1)).toBe('diagram-20260912-194503-1.png')
  })

  // The whole point: a name from a clipboard or another application is not a path this app may write.
  it('cannot be made to climb out of the folder it writes into', () => {
    const name = attachmentNameOf('../../etc/passwd', 'image/png', at, 1)
    expect(name).not.toContain('..')
    expect(name).not.toContain('/')
    expect(name).not.toContain('\\')
  })

  it('strips a drive letter and a separator out of a Windows path', () => {
    const name = attachmentNameOf('C:\\Users\\me\\secret.png', 'image/png', at, 2)
    expect(name).not.toContain(':')
    expect(name).not.toContain('\\')
  })

  // A clipboard image has no name of its own.
  it('names an unnamed paste after the clock', () => {
    expect(attachmentNameOf('', 'image/png', at, 3)).toBe('pasted-20260912-194503-3.png')
  })

  it('takes the extension from the type rather than the name', () => {
    expect(attachmentNameOf('shot.bin', 'image/jpeg', at, 4)).toBe('shot-20260912-194503-4.jpg')
  })

  // Two pastes inside the same second are two different files.
  it('gives two files in the same second different names', () => {
    expect(attachmentNameOf('', 'image/png', at, 1)).not.toBe(attachmentNameOf('', 'image/png', at, 2))
  })

  it('keeps a name that is nothing but unsafe characters from becoming a stray dash', () => {
    expect(attachmentNameOf('///', 'image/png', at, 5)).toBe('pasted-20260912-194503-5.png')
  })
})
