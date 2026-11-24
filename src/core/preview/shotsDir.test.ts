import { describe, it, expect } from 'vitest'
import { previewShotsReadRule } from './shotsDir'

// The form Claude Code 2.1.331 honours, measured with `claude -p` in the default permission mode on Windows: a rule
// written `Read(//f/astera-work/.../shots/**)` let a read outside the working directory through without a question,
// `Read(//F:/astera-work/.../shots/**)` was refused exactly like no rule at all.
describe('previewShotsReadRule', () => {
  it('writes a Windows folder the way Claude matches it: a lower-case drive after //, forward slashes, all below it', () => {
    expect(previewShotsReadRule('C:\\Users\\Jane Doe\\AppData\\Roaming\\astera\\preview\\shots', 'win32')).toBe(
      'Read(//c/Users/Jane Doe/AppData/Roaming/astera/preview/shots/**)'
    )
  })

  it('writes a POSIX folder after //, which Claude reads as the filesystem root', () => {
    expect(previewShotsReadRule('/home/jane/.config/astera/preview/shots', 'linux')).toBe(
      'Read(//home/jane/.config/astera/preview/shots/**)'
    )
    expect(previewShotsReadRule('/Users/jane/Library/Application Support/astera/preview/shots/', 'darwin')).toBe(
      'Read(//Users/jane/Library/Application Support/astera/preview/shots/**)'
    )
  })
})
