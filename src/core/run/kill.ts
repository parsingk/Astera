// Process-tree kill command. On win32 children are force-killed too (taskkill /T /F);
// on posix it returns null and the caller ends the process group with pty.kill().
export function treeKillCommand(
  platform: NodeJS.Platform,
  pid: number
): { file: string; args: string[] } | null {
  if (platform === 'win32') return { file: 'taskkill', args: ['/pid', String(pid), '/T', '/F'] }
  return null
}
