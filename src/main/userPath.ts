// The win32 user Path, for the Install and Uninstall buttons of the astera command (Settings → Agents).
//
// **Only the one entry this app owns, only when the person asked** (the checkbox beside Install). The
// value is read and written as the registry holds it, not through [Environment]::SetEnvironmentVariable:
// that writes REG_SZ, and a Path of kind REG_EXPAND_SZ holding %USERPROFILE%-style entries would stop
// expanding them — the person's other tools would vanish from new shells. So the kind is kept, the
// variables stay unexpanded (DoNotExpandEnvironmentNames), and the new value crosses as base64 so no
// quoting of it can go wrong. Afterwards WM_SETTINGCHANGE tells Explorer, so a shell opened from it next
// sees the change; a shell already open keeps the Path it started with.
//
// **A Path too long is not written.** Past a length Windows gives no new shell the user Path at all
// (cliInstall.ts userPathFits), so adding our entry there would take every other tool on it away too.
//
// Windows PowerShell is started by its absolute path, never by name: a bare name is looked up in the
// working directory first (core/sessions/windowsExecutable.ts).
import { execFile } from 'node:child_process'
import path from 'node:path'
import { userPathFits, userPathWith, userPathWithout } from '../core/orchestration/cliInstall'

/** Runs one PowerShell script and resolves with what it printed. Injectable for tests. */
export type RunPowerShell = (script: string) => Promise<string>

/** `timeoutMs` is for the test that runs these scripts for real in a full test run, where starting
 *  PowerShell alone can take most of the default. */
export const runWindowsPowerShell = (script: string, timeoutMs = 15_000): Promise<string> =>
  new Promise((resolve, reject) => {
    const exe = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    execFile(
      exe,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    )
  })

type Kind = 'String' | 'ExpandString' | 'None'

/** `HKCU\Environment` is where the user Path lives. A test passes a scratch key of its own. */
const USER_ENV_KEY = 'Environment'

const readScript = (key: string): string => [
  `[Console]::OutputEncoding = [Text.Encoding]::UTF8`,
  `$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key}')`,
  `$v = if ($k) { $k.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }`,
  `$kind = if ($v -eq $null) { 'None' } else { $k.GetValueKind('Path').ToString() }`,
  // The system Path, for the length both make together (userPathFits)
  `$m = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')`,
  `$mv = if ($m) { $m.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { '' }`,
  `[Console]::Out.Write((@{ kind = $kind; value = [string]$v; machine = [string]$mv } | ConvertTo-Json -Compress))`
].join('\n')

/** The script that writes `value` as the user Path with `kind`, then tells Explorer. */
export function writeUserPathScript(value: string, kind: 'String' | 'ExpandString', key: string = USER_ENV_KEY): string {
  const b64 = Buffer.from(value, 'utf8').toString('base64')
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$v = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))`,
    `$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${key}')`,
    `$k.SetValue('Path', $v, [Microsoft.Win32.RegistryValueKind]::${kind})`,
    `$k.Close()`,
    `Add-Type -Namespace AsteraUserPath -Name Native -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'`,
    `$r = [UIntPtr]::Zero`,
    // HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG: a window that does not answer in 5s is skipped
    `[void][AsteraUserPath.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)`
  ].join('\n')
}

async function readUserPath(run: RunPowerShell, key: string): Promise<{ kind: Kind; value: string; machine: string }> {
  const parsed = JSON.parse((await run(readScript(key))).trim()) as { kind?: unknown; value?: unknown; machine?: unknown }
  const kind: Kind = parsed.kind === 'String' || parsed.kind === 'ExpandString' ? parsed.kind : 'None'
  return {
    kind,
    value: typeof parsed.value === 'string' ? parsed.value : '',
    machine: typeof parsed.machine === 'string' ? parsed.machine : ''
  }
}

/** Whether the user Path names `dir`, and whether new shells are given that Path with `dir` on it
 *  (userPathFits): what a shell opened next will have, which this app's own environment, read once at its
 *  start, cannot say. `fits` counts `dir` even when it is not there yet, so a Path Install refused stays
 *  reported, and the panel does not offer a line that would make it too long. */
export async function userPathStatus(a: {
  dir: string
  env: NodeJS.ProcessEnv
  run?: RunPowerShell
  key?: string
}): Promise<{ has: boolean; fits: boolean }> {
  const now = await readUserPath(a.run ?? runWindowsPowerShell, a.key ?? USER_ENV_KEY)
  const withDir = userPathWith(now.value, a.dir, a.env)
  return { has: withDir === null, fits: userPathFits({ machine: now.machine, user: withDir ?? now.value, env: a.env }) }
}

/** Puts `dir` at the end of the user Path, keeping the value's kind. 'present' when it was there.
 *  'tooLong', writing nothing, when new shells would not be given the longer value: Windows would then
 *  leave out the whole user Path, and every other tool on it with ours. */
export async function addToUserPath(a: {
  dir: string
  env: NodeJS.ProcessEnv
  run?: RunPowerShell
  key?: string
}): Promise<'added' | 'present' | 'tooLong'> {
  const run = a.run ?? runWindowsPowerShell
  const key = a.key ?? USER_ENV_KEY
  const now = await readUserPath(run, key)
  const next = userPathWith(now.value, a.dir, a.env)
  if (next === null) return 'present'
  if (!userPathFits({ machine: now.machine, user: next, env: a.env })) return 'tooLong'
  // A Path that does not exist yet is made the kind Windows itself makes it
  await run(writeUserPathScript(next, now.kind === 'String' ? 'String' : 'ExpandString', key))
  return 'added'
}

/** Takes `dir` off the user Path when it is what keeps that Path from new shells: the Path is too long
 *  with it and fits without it. 1.4.1 added it without the length check, so a Path just under the limit
 *  went over and every tool on it was gone from new shells. Anything else is left as it is. */
export async function takeOffUserPathIfItBreaks(a: {
  dir: string
  env: NodeJS.ProcessEnv
  run?: RunPowerShell
  key?: string
}): Promise<'removed' | 'kept'> {
  const run = a.run ?? runWindowsPowerShell
  const key = a.key ?? USER_ENV_KEY
  const now = await readUserPath(run, key)
  const without = userPathWithout(now.value, a.dir, a.env)
  if (without === null) return 'kept'
  if (userPathFits({ machine: now.machine, user: now.value, env: a.env })) return 'kept'
  if (!userPathFits({ machine: now.machine, user: without, env: a.env })) return 'kept'
  await run(writeUserPathScript(without, now.kind === 'String' ? 'String' : 'ExpandString', key))
  return 'removed'
}

/** Takes every entry that is `dir` out of the user Path, keeping the value's kind and every other
 *  entry. 'absent' when there was none. */
export async function removeFromUserPath(a: {
  dir: string
  env: NodeJS.ProcessEnv
  run?: RunPowerShell
  key?: string
}): Promise<'removed' | 'absent'> {
  const run = a.run ?? runWindowsPowerShell
  const key = a.key ?? USER_ENV_KEY
  const now = await readUserPath(run, key)
  const next = userPathWithout(now.value, a.dir, a.env)
  if (next === null) return 'absent'
  await run(writeUserPathScript(next, now.kind === 'String' ? 'String' : 'ExpandString', key))
  return 'removed'
}
