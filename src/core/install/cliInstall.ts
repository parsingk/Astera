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
    // A login shell, because that is what reads the profile files an installer appends a PATH line to.
    const line = `command -v ${cli}`
    return { command: loginShell, args: ['-lc', line], display: line, source: SOURCES[cli] }
  }
  return null
}
