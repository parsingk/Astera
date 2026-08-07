/** Interactive shell resolution. Pure function — the file-existence check is injected as exists to keep it testable. */
export interface ShellSpawn {
  file: string
  args: string[]
}

// win32 candidate order: PS7 → PS5 → cmd. The earlier ones are better to develop with, so they win.
const WIN_CANDIDATES = ['pwsh.exe', 'powershell.exe', 'cmd.exe']

/**
 * Decides which shell to launch from platform and exists (whether it is on PATH).
 * win32: takes the first of WIN_CANDIDATES that exists, and returns cmd.exe as the fallback when none do
 * (if even that fails to spawn, the caller raises the exception up to the renderer).
 * Otherwise: envShell (the caller passes process.env.SHELL) or /bin/sh.
 */
export function resolveShell(
  platform: NodeJS.Platform,
  exists: (file: string) => boolean,
  envShell?: string
): ShellSpawn {
  if (platform === 'win32') {
    return { file: WIN_CANDIDATES.find(exists) ?? 'cmd.exe', args: [] }
  }
  return { file: envShell || '/bin/sh', args: [] }
}
