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
 *  wrapper alone leaves claude or codex running. taskkill /T walks the tree from a live parent, so the parent itself is
 *  killed after taskkill answered, and a child already gone is left alone: Windows hands its id to the next process
 *  soon (final review I-1, I-2; the shape of scriptWorker's endChild). Never throws. */
export function killProcessTree(
  child: { pid?: number; exitCode?: number | null; signalCode?: string | null; kill(): boolean },
  o: { platform?: NodeJS.Platform; exec?: (file: string, args: string[], done: () => void) => void } = {}
): void {
  const alive = (): boolean => (child.exitCode ?? null) === null && (child.signalCode ?? null) === null
  if (!alive()) return
  const hard = (): void => {
    try {
      if (alive()) child.kill()
    } catch {
      // already exited
    }
  }
  const platform = o.platform ?? process.platform
  const cmd = child.pid !== undefined ? treeKillCommand(platform, child.pid) : null
  if (!cmd) return hard()
  const exec = o.exec ?? ((file: string, args: string[], done: () => void) => void execFile(file, args, { windowsHide: true, timeout: 10_000 }, () => done()))
  try {
    exec(cmd.file, cmd.args, hard)
  } catch {
    hard()
  }
}
