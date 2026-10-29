// The shell a sandboxed Task's check runs its line in, inside `codex sandbox` (Task K). Today a check runs as
// `cmd.exe /s /c "<line>"` on Windows and `sh -c <line>` elsewhere (core/run/shell.ts); inside codex it keeps that shape.
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Where a Windows check line holding a double quote is written: the temp folder, which a sandboxed session reads. */
export const checkScriptDir = (tmpDir: string): string => path.join(tmpDir, 'astera-checks')

/**
 * The command after `codex sandbox --` for a check's `line`: `sh -c <line>`, and on Windows `cmd.exe /d /s /c <line>`.
 * Codex hands its command to cmd.exe quoted with backslash escapes (windows-sandbox-rs/src/winutil.rs:72-112 at
 * rust-v0.160.0), which cmd.exe does not read, as the S2 measurement found (scripts/measure/s2.mjs WIN32_PROBES); so a
 * Windows line holding a double quote (a quoted path, build.ts quoteArg) is written to a script file named by its text and
 * run as `cmd.exe /d /c <file>`. Inside a script `%` reads as it does in a batch file, not on a command line.
 *
 * `mark` (Windows, fix round 2): printed as a line of its own before the check runs, so Astera's runner knows the check
 * started and a `codex sandbox` that stopped before it is the sandbox's failure (checkRunner.ts). `echo <mark>&` before the
 * line leaves the line's own exit code and its `&&`, `||` and `|` as they were; a script prints it on its first line. A
 * script is named by its whole text, so the same line with and without the mark never shares one.
 */
export function checkShell(platform: NodeJS.Platform, line: string, tmpDir: string, mark?: string): string[] {
  if (platform !== 'win32') return ['sh', '-c', line]
  if (!line.includes('"')) return ['cmd.exe', '/d', '/s', '/c', mark ? `echo ${mark}& ${line}` : line]
  const dir = checkScriptDir(tmpDir)
  mkdirSync(dir, { recursive: true })
  const text = `@echo off\r\n${mark ? `echo ${mark}\r\n` : ''}${line}\r\nexit /b %ERRORLEVEL%\r\n`
  const file = path.join(dir, `check-${createHash('sha256').update(text).digest('hex').slice(0, 16)}.cmd`)
  writeFileSync(file, text)
  return ['cmd.exe', '/d', '/c', file]
}
