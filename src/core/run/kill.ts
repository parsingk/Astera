import { execFile } from 'node:child_process'

// Process-tree kill command. On win32 children are force-killed too (taskkill /T /F);
// on posix it returns null and the caller ends the process group with pty.kill().
export function treeKillCommand(
  platform: NodeJS.Platform,
  pid: number
): { file: string; args: string[] } | null {
  if (platform === 'win32') return { file: 'taskkill', args: ['/pid', String(pid), '/T', '/F'] }
  return null
}

/** Kills a child and, on win32, everything it started (audit U-4): a `.cmd` shim runs under cmd.exe, and killing the
 *  wrapper alone leaves claude or codex running. Never throws: the process may be gone already. */
export function killProcessTree(
  child: { pid?: number; kill(): boolean },
  o: { platform?: NodeJS.Platform; exec?: (file: string, args: string[]) => void } = {}
): void {
  const platform = o.platform ?? process.platform
  const exec = o.exec ?? ((file: string, args: string[]) => void execFile(file, args, { windowsHide: true }, () => {}))
  const cmd = child.pid !== undefined ? treeKillCommand(platform, child.pid) : null
  try {
    if (cmd) exec(cmd.file, cmd.args)
  } catch {
    // taskkill failing means the tree is already gone; the kill below is the backstop
  }
  try {
    child.kill()
  } catch {
    // already exited
  }
}
