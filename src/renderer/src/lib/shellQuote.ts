const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/

/** One argument as a single-quoted word both PowerShell and POSIX shells read back unchanged (backslashes stay).
 *  An inner single quote is doubled on Windows (PowerShell) and written `'\''` elsewhere. */
export function shellQuote(arg: string, platform: string): string {
  if (SAFE.test(arg)) return arg
  const inner = platform === 'win32' ? arg.replace(/'/g, "''") : arg.replace(/'/g, "'\\''")
  return `'${inner}'`
}
