// Real file references on the OS clipboard, so that Copy in the file explorer can be pasted into
// Windows Explorer as the files themselves and not as their paths in text.
//
// Why an external process. Electron's clipboard module cannot write CF_HDROP, the format Explorer
// pastes files from, and there is no flag that turns it on. Measured on Electron 41:
// clipboard.writeBuffer('FileNameW', …) registers a clipboard format of that name and nothing more —
// .NET will synthesise a FileDrop view of it, Explorer will not, so its Paste stays greyed out.
// Windows PowerShell can put a real CF_HDROP there, so a short-lived one is spawned for the write.
// It has to be powershell.exe (5.1), not pwsh: PowerShell 7 dropped Set-Clipboard's -Path, and the
// System.Windows.Forms clipboard needs an STA thread, which powershell.exe gives with -Sta.
//
// The clipboard also keeps the paths as text, because that is what Ctrl+C on a file has always put
// there and a session terminal is pasted into far more often than Explorer is. One DataObject
// carries both, so neither use loses.
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type ClipboardFilesResult = { ok: true } | { ok: false; reason: 'unsupported-platform' | 'failed' }

export interface ClipboardFilesDeps {
  platform: NodeJS.Platform
  /** Where the list of paths is handed over. Injectable for the same reason as GitSummaryDeps.git — the test needs its own. */
  tmpDir: string
  run: (file: string, args: string[]) => Promise<void>
}

const runPowerShell = (file: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    // No shell, so the arguments are passed as they are. The timeout is the guard against a
    // PowerShell that never returns (a wedged clipboard owner can block the OLE call).
    execFile(file, args, { timeout: 10_000, windowsHide: true }, (err) => (err ? reject(err) : resolve()))
  })

const defaultDeps = (): ClipboardFilesDeps => ({
  platform: process.platform,
  tmpDir: os.tmpdir(),
  run: runPowerShell
})

/** The script that does the write. listPath holds one path per line, UTF-8.
 *
 *  The selection goes through a file rather than the command line: a command line is capped at about
 *  32k characters, and a path can hold quotes. Only this one generated path is interpolated, and it
 *  is quoted the PowerShell way (a single quote doubles) so even that cannot break out.
 *
 *  SetDataObject's second argument is the one that matters most — it copies the data into the
 *  clipboard, so it survives this process exiting a moment later. Without it the clipboard holds a
 *  reference to a dead process and every reader, this app included, gets nothing back.
 *
 *  The retry is for a clipboard another program is holding open at that instant, which Windows
 *  reports as "Requested Clipboard operation did not succeed" and which passes on its own. */
export function clipboardFilesScript(listPath: string): string {
  const quoted = `'${listPath.replace(/'/g, "''")}'`
  return [
    `$ErrorActionPreference = 'Stop'`,
    `Add-Type -AssemblyName System.Windows.Forms`,
    `$paths = @(Get-Content -LiteralPath ${quoted} -Encoding UTF8 | Where-Object { $_ -ne '' })`,
    `$files = New-Object System.Collections.Specialized.StringCollection`,
    `foreach ($p in $paths) { [void]$files.Add($p) }`,
    `$data = New-Object System.Windows.Forms.DataObject`,
    `$data.SetFileDropList($files)`,
    // [char]10 rather than an escaped newline: the text form has always been LF-joined, and a CRLF
    // pasted into a terminal would submit the line it ends.
    `$data.SetText([string]::Join([string][char]10, $paths))`,
    `for ($i = 0; $i -lt 3; $i++) {`,
    `  try {`,
    `    [System.Windows.Forms.Clipboard]::SetDataObject($data, $true)`,
    `    exit 0`,
    `  } catch {`,
    `    Start-Sleep -Milliseconds 120`,
    `  }`,
    `}`,
    `exit 1`
  ].join('\n')
}

/** Puts paths on the OS clipboard as files. Never throws — the caller has already put the same paths
 *  there as text, so a failure means the clipboard is one step less useful, not that the copy broke.
 *
 *  win32 only. macOS ('public.file-url') and Linux (wl-copy/xclip) each need their own mechanism and
 *  a machine to verify it on; until then they keep the text, which is what they had. */
export async function writeFilesToClipboard(
  paths: string[],
  deps: ClipboardFilesDeps = defaultDeps()
): Promise<ClipboardFilesResult> {
  if (deps.platform !== 'win32') return { ok: false, reason: 'unsupported-platform' }
  const listPath = path.join(deps.tmpDir, `astera-clipboard-${process.pid}-${Date.now()}.txt`)
  try {
    await fs.writeFile(listPath, paths.join('\n'), 'utf8')
    // -EncodedCommand (UTF-16LE base64) so the script crosses the command line as a single token —
    // no quoting of its own to get wrong, and no profile or execution policy in the way.
    const encoded = Buffer.from(clipboardFilesScript(listPath), 'utf16le').toString('base64')
    await deps.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-EncodedCommand', encoded])
    return { ok: true }
  } catch {
    return { ok: false, reason: 'failed' }
  } finally {
    await fs.rm(listPath, { force: true }).catch(() => {
      // A leftover list file in the temp directory is not worth reporting a failed copy over.
    })
  }
}
