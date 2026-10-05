import { describe, it, expect } from 'vitest'
import { binaryMissingIn } from './runner'

describe('binaryMissingIn', () => {
  it('reads the path from the npm launcher\'s "binary not found" line', () => {
    const stderr = '@higgsfield/cli: binary not found at C:\\Program Files\\nodejs\\node_modules\\@higgsfield\\cli\\vendor\\hf.exe. Reinstall: npm i -g @higgsfield/cli\n'
    expect(binaryMissingIn({ code: 1, stdout: '', stderr }))
      .toBe('C:\\Program Files\\nodejs\\node_modules\\@higgsfield\\cli\\vendor\\hf.exe')
    expect(binaryMissingIn({ code: 1, stdout: '', stderr: '@higgsfield/cli: binary not found at /usr/lib/node_modules/@higgsfield/cli/vendor/hf\n' }))
      .toBe('/usr/lib/node_modules/@higgsfield/cli/vendor/hf')
  })
  it('is null for a run that succeeded or failed for another reason', () => {
    expect(binaryMissingIn({ code: 0, stdout: 'binary not found at x', stderr: '' })).toBeNull()
    expect(binaryMissingIn({ code: 2, stdout: '', stderr: 'Error: Session expired.\nHint: Run: hf auth login' })).toBeNull()
  })
})
