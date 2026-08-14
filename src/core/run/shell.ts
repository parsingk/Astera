/** How an assembled run command is handed to a shell. Pure, so the decision is tested here rather
 *  than in main; returns `{ file, args }` for the main process to spawn, the same shape as
 *  kill.ts's treeKillCommand. Assembling the command string is a different job and lives in build.ts.
 *
 *  **The asymmetry is deliberate: win32 gets a string, posix gets an array. Do not "tidy" it into an
 *  array on both sides — the quoting quoteArg (build.ts) puts on every value breaks silently if you
 *  do.**
 *
 *  Why a string on win32: node-pty turns an args *array* into a command line with argsToCommandLine
 *  (node_modules/node-pty/src/windowsPtyAgent.ts:255), which wraps any argument containing a space in
 *  `"` and escapes the `"` already inside it as `\"` — the MSVCRT convention. cmd.exe does not know
 *  `\"`. Measured against that function and a real child that prints its argv:
 *    node show.js "scripts/a b.js"  ->  cmd.exe /c "node show.js \"scripts/a b.js\""
 *    child argv: ["scripts/a] [b.js"]      — one value arrived as two
 *  When args is a *string*, the same function returns `${argsToCommandLine(file, [])} ${args}`
 *  (lines 256-261): the args go in **verbatim, with no escaping at all**, while the file still goes
 *  through the quoting pass. Here the two coincide — `cmd.exe` holds no character that pass reacts to
 *  (no space, no quote), so it comes back unchanged and the command line is exactly `cmd.exe ${args}`.
 *  What we assembled is what cmd.exe reads.
 *
 *  Why /s: with plain `/c "…"` a command that *starts* with a quoted path — exactly what a config with
 *  an interpreter or a node executable produces — hits cmd's rule about the first and last quote:
 *    cmd.exe /c "C:\Program Files\nodejs\node.exe" show.js "my script.py"
 *      -> 'C:\Program' is not recognized as a program
 *    cmd.exe /s /c ""C:\Program Files\nodejs\node.exe" show.js "my script.py""
 *      -> runs, argv holds `my script.py` intact
 *  /s means "strip only the first and last quote and use the rest as-is", which is precisely what an
 *  already-quoted command needs. src/main/shellSpawn.test.ts pins this against real processes. */
export function shellSpawn(command: string, platform: string): { file: string; args: string[] | string } {
  if (platform !== 'win32') return { file: 'sh', args: ['-c', command] }
  return { file: 'cmd.exe', args: `/s /c "${command}"` }
}
