// The Host's rolling lines go to the same rolling.log the app writes (S6 R10), so one file tells what
// happened to a session whichever process rolled it. Imports only node builtins.
import { appendFileSync } from 'node:fs'
import path from 'node:path'

/** Appends one line to <profile>/rolling.log with the prefix; never throws (R10). */
export function hostRollingLog(profileDir: string, prefix: '[host]' | '[host][codex]'): (m: string) => void {
  const file = path.join(profileDir, 'rolling.log')
  return (m) => {
    try {
      appendFileSync(file, `${new Date().toISOString()} ${prefix} ${m}\n`)
    } catch {
      /* a log line never costs a roll */
    }
  }
}
