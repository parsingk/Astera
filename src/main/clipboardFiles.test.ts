import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeFilesToClipboard, clipboardFilesScript } from './clipboardFiles'

let tmpDir: string
let calls: { file: string; args: string[] }[]

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-clipfiles-'))
  calls = []
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const decodeScript = (args: string[]): string =>
  Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')

/** The list file the script would read. Captured while the fake PowerShell "runs", because the real
 *  one is deleted as soon as the process ends. */
const runReading = (seen: { listPath?: string; list?: string }) => {
  return async (file: string, args: string[]): Promise<void> => {
    calls.push({ file, args })
    const script = decodeScript(args)
    const listPath = /Get-Content -LiteralPath '([^']*)'/.exec(script)?.[1]
    if (listPath) {
      seen.listPath = listPath
      seen.list = await fs.readFile(listPath, 'utf8')
    }
  }
}

describe('writeFilesToClipboard', () => {
  it('hands PowerShell the selection, one path per line', async () => {
    const seen: { listPath?: string; list?: string } = {}
    const result = await writeFilesToClipboard(['D:\\p\\a.ts', 'D:\\p\\b (1).ts'], {
      platform: 'win32',
      tmpDir,
      run: runReading(seen)
    })

    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('powershell.exe')
    expect(calls[0].args).toContain('-NoProfile')
    expect(calls[0].args).toContain('-Sta')
    expect(seen.list?.split(/\r?\n/).filter(Boolean)).toEqual(['D:\\p\\a.ts', 'D:\\p\\b (1).ts'])
    expect(decodeScript(calls[0].args)).toBe(clipboardFilesScript(seen.listPath!))
  })

  it('deletes the list file once PowerShell is done', async () => {
    const seen: { listPath?: string; list?: string } = {}
    await writeFilesToClipboard(['D:\\p\\a.ts'], { platform: 'win32', tmpDir, run: runReading(seen) })

    await expect(fs.access(seen.listPath!)).rejects.toThrow()
  })

  it('reports a failure, and still deletes the list file, when PowerShell fails', async () => {
    const seen: { listPath?: string } = {}
    const result = await writeFilesToClipboard(['D:\\p\\a.ts'], {
      platform: 'win32',
      tmpDir,
      run: async (_file, args) => {
        seen.listPath = /Get-Content -LiteralPath '([^']*)'/.exec(decodeScript(args))?.[1]
        throw new Error('powershell.exe ENOENT')
      }
    })

    expect(result).toEqual({ ok: false, reason: 'failed' })
    await expect(fs.access(seen.listPath!)).rejects.toThrow()
  })

  // The whole mechanism is the Windows one (CF_HDROP through PowerShell). Elsewhere the caller keeps
  // the path text it already put on the clipboard, so this reports rather than throws.
  it('does nothing on a platform it has no mechanism for', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const result = await writeFilesToClipboard(['/p/a.ts'], {
        platform,
        tmpDir,
        run: async (file, args) => {
          calls.push({ file, args })
        }
      })
      expect(result).toEqual({ ok: false, reason: 'unsupported-platform' })
    }
    expect(calls).toEqual([])
  })
})

describe('clipboardFilesScript', () => {
  it('puts both the files and their paths as text on the clipboard', () => {
    const script = clipboardFilesScript('C:\\tmp\\astera-clip-1.txt')
    expect(script).toContain('SetFileDropList')
    expect(script).toContain('SetText')
    // copy=true, or the clipboard would hold a reference into a process that is about to exit
    expect(script).toContain('SetDataObject($data, $true)')
  })

  it("closes the quote on a list path that contains one", () => {
    expect(clipboardFilesScript("C:\\it's\\list.txt")).toContain("-LiteralPath 'C:\\it''s\\list.txt'")
  })
})
