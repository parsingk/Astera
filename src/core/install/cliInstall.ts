/** The two CLIs this app launches. */
export type InstallableCli = 'claude' | 'codex'

/** A command to run, already split — never a string for a shell to re-parse. The arguments carry a
 *  pipeline the *inner* shell runs; the outer one is only a runner, which is why nothing here is
 *  built from anything a person typed. */
export interface InstallCommand {
  command: string
  args: string[]
  /** The same thing as one line, for the screen to show beside the button. Someone who would rather
   *  run it themselves, or who has to after a failure, needs it in a form they can copy. */
  display: string
  /** Where the bytes come from, for the screen to say out loud. A button that runs a download is a
   *  thing to be wary of, and naming the vendor's own host is the answer to that wariness — the same
   *  answer the command gives a reader who can read it. */
  source: string
}

/** The host each vendor serves its installer from. Beside the commands on purpose: if one ever moves,
 *  the sentence on screen and the command under it move together. */
const SOURCES: Readonly<Record<InstallableCli, string>> = {
  claude: 'claude.ai',
  codex: 'chatgpt.com'
}

/**
 * What each vendor documents as the way to install their CLI, per platform.
 *
 * The native installers, not npm: they bring their own binary, so they work on a machine that has
 * never had Node on it — which is the machine this screen exists for (both docs read 2026-09-13,
 * code.claude.com/docs/en/setup and the codex README). npm would need Node 22+ for Claude Code, and
 * asking someone to install a runtime to install a CLI is a second wall in front of the first.
 *
 * The URLs are constants and the pipeline is the vendor's own wording, kept verbatim so this can be
 * compared against their documentation by eye. Nothing here is assembled from user input.
 */
const COMMANDS: Readonly<Record<'win32' | 'posix', Readonly<Record<InstallableCli, string>>>> = {
  win32: {
    claude: 'irm https://claude.ai/install.ps1 | iex',
    codex: 'irm https://chatgpt.com/codex/install.ps1 | iex'
  },
  posix: {
    claude: 'curl -fsSL https://claude.ai/install.sh | bash',
    codex: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'
  }
}

/**
 * How to install one CLI on this platform, or null where neither vendor documents one.
 *
 * null is not a failure to handle later: the screen keeps showing the commands to run by hand, which
 * is exactly what it did before any of this existed. A platform nobody has measured is better served
 * by the text than by a button that runs something invented for it.
 */
export function installCommandFor(cli: InstallableCli, platform: string): InstallCommand | null {
  if (platform === 'win32') {
    const line = COMMANDS.win32[cli]
    return {
      // -NoProfile so a profile that prints, prompts or fails cannot take the install with it.
      // -ExecutionPolicy Bypass for this process only, which is what the vendor's own Windows
      // instructions rely on — it changes nothing on the machine.
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', line],
      display: line,
      source: SOURCES[cli]
    }
  }
  if (platform === 'darwin' || platform === 'linux') {
    const line = COMMANDS.posix[cli]
    // `sh -c` is only the runner; the pipeline names its own interpreter, exactly as documented.
    return { command: '/bin/sh', args: ['-c', line], display: line, source: SOURCES[cli] }
  }
  return null
}

/**
 * How to ask this machine where a CLI is, **as the machine sees it now** rather than as this process
 * was told at launch.
 *
 * An installer writes the new directory into the environment the operating system keeps; it cannot
 * reach into a program that is already running, whose environment was copied when it started. So
 * after an install this app still cannot see what it just installed — and restarting does not fix it
 * either, because a relaunch inherits the same stale copy (measured: the app came back and still
 * found neither CLI).
 *
 * Hence asking rather than guessing. Windows keeps the authoritative value in the Machine and User
 * environment blocks; a POSIX login shell builds it from the profile files the installer edited.
 * Neither answer depends on this app knowing where a vendor decided to put its binary, which is the
 * one thing that would quietly rot when a vendor moves it.
 *
 * `loginShell` is the caller's `$SHELL`, or any POSIX shell when that is unset — passed in rather
 * than read here so this stays a function of its arguments.
 */
export function locateCommandFor(
  cli: InstallableCli,
  platform: string,
  loginShell: string
): InstallCommand | null {
  if (platform === 'win32') {
    // Machine first, then User: the same order Windows composes PATH in, so a per-user install is
    // found even when a machine-wide one of the same name exists.
    const line =
      "$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + " +
      "[Environment]::GetEnvironmentVariable('Path','User'); " +
      `(Get-Command ${cli} -ErrorAction SilentlyContinue).Source`
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', line],
      display: line,
      source: SOURCES[cli]
    }
  }
  if (platform === 'darwin' || platform === 'linux') {
    // An interactive login shell, as the app's own PATH probe asks (main/loginPath.ts): the PATH line
    // Claude Code's note asks for goes in ~/.zshrc or ~/.bashrc, which a non-interactive shell never
    // reads. Its aliases and functions are dropped first, since `command -v` names those before a file.
    // The answer is marked, since an rc file may print before it (parseLocated).
    const line = `unalias ${cli} 2>/dev/null; unset -f ${cli} 2>/dev/null; printf '${LOCATED}%s\\n' "$(command -v ${cli})"`
    return { command: loginShell, args: ['-ilc', line], display: line, source: SOURCES[cli] }
  }
  return null
}

/** What the macOS and Linux locate command prints before the path it found. */
export const LOCATED = '__ASTERA_CLI__'

/** The path a locate command printed, or null: the marked line where there is one (an rc file may print
 *  before it), else the first non-empty line (Windows PowerShell prints only the path). */
export function parseLocated(stdout: string): string | null {
  const lines = stdout.split('\n').map((l) => l.trim())
  const marked = lines.find((l) => l.startsWith(LOCATED))
  if (marked !== undefined) return marked.slice(LOCATED.length).trim() || null
  return lines.find((l) => l !== '') ?? null
}

/**
 * The folder a vendor's installer documents putting its CLI in while it leaves PATH to the person, or
 * null for one that puts its own folder on PATH.
 *
 * Only Claude Code: its installer writes `%USERPROFILE%\.local\bin\claude.exe` on Windows and
 * `~/.local/bin/claude` on macOS and Linux, and "prints the fix with that note but doesn't change PATH
 * itself" (code.claude.com/docs/en/troubleshoot-install, read 2026-10-10). Without its folder on PATH
 * the app it was installed from could not find it, and said it was not installed. Codex's installer adds
 * its own folder (measured on Windows).
 */
export function unpathedInstallDir(cli: InstallableCli, platform: string, home: string): string | null {
  if (cli !== 'claude') return null
  if (platform === 'win32') return `${home.replace(/[\\/]+$/, '')}\\.local\\bin`
  if (platform === 'darwin' || platform === 'linux') return `${home.replace(/\/+$/, '')}/.local/bin`
  return null
}

/** The PATH line Claude Code's note asks a macOS or Linux person to add, verbatim. */
export const PROFILE_PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"'

/**
 * The file that line goes in for this shell, as the same note says: zsh reads `~/.zshrc` (in `ZDOTDIR`
 * when that is set); bash on Linux `~/.bashrc`; bash on macOS, whose terminals start login shells, the
 * first of `~/.bash_profile`, `~/.bash_login` and `~/.profile` there is, `~/.bash_profile` when there is
 * none. null for any other shell, whose syntax may differ (fish), or none at all: nothing is written.
 */
export function profileFileFor(o: {
  shell: string | undefined
  platform: string
  home: string
  zdotdir?: string
  exists: (file: string) => boolean
}): string | null {
  const name = (o.shell ?? '').split('/').pop() ?? ''
  const home = o.home.replace(/\/+$/, '')
  if (name === 'zsh') return `${(o.zdotdir || home).replace(/\/+$/, '')}/.zshrc`
  if (name !== 'bash') return null
  if (o.platform === 'linux') return `${home}/.bashrc`
  if (o.platform !== 'darwin') return null
  const login = ['.bash_profile', '.bash_login', '.profile'].map((f) => `${home}/${f}`)
  return login.find((f) => o.exists(f)) ?? login[0]
}

/**
 * Appends a folder to the user's own saved Path, once, the way the vendor's note asks a person to.
 *
 * Read and written raw through the registry, so the entries a person wrote with `%VARIABLES%` stay
 * variables and the value stays expandable (`[Environment]::SetEnvironmentVariable` would write back
 * every entry expanded); a folder already there, with or without a trailing backslash, changes nothing.
 * Windows is then told the environment changed, so a terminal opened from now on finds it too.
 * `key` is the registry key under HKCU, which only a test changes.
 */
export function addUserPathCommand(dir: string, key = 'Environment'): InstallCommand {
  const q = (s: string): string => `'${s.replace(/'/g, "''")}'`
  const line =
    `$d = ${q(dir)}; $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(${q(key)}); ` +
    "$p = [string]$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); " +
    "$parts = @($p -split ';' | Where-Object { $_ -ne '' }); " +
    "if (-not ($parts | Where-Object { $_.Trim('\"').TrimEnd('\\') -ieq $d.TrimEnd('\\') })) { " +
    "$k.SetValue('Path', (($parts + $d.TrimEnd('\\')) -join ';'), 'ExpandString'); " +
    "Add-Type -Namespace Astera -Name Env -MemberDefinition '[DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);'; " +
    "$r = [UIntPtr]::Zero; [void][Astera.Env]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r) }"
  return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', line], display: line, source: 'this PC' }
}
