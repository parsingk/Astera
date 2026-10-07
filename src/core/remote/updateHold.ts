// The update hold (remote runtime design §2.9): before an installer replaces files, the app writes
// `<profile>/host/update-hold` and retires the Host; `astera runtime serve` starts no Host while the hold is valid, so it
// does not race the installer for the files it is replacing. The new app removes it at boot. A hold whose writer is
// gone, or whose time has passed, holds nothing: an installer that died must not keep the Runtime down for good.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface UpdateHold {
  pid: number
  /** Epoch milliseconds. */
  until: number
}

/** How long a hold lasts when the app writes it (§2.9). */
export const UPDATE_HOLD_MS = 10 * 60 * 1000

const holdPath = (profileDir: string): string => path.join(profileDir, 'host', 'update-hold')

export function writeUpdateHold(profileDir: string, hold: UpdateHold): void {
  mkdirSync(path.dirname(holdPath(profileDir)), { recursive: true })
  writeFileSync(holdPath(profileDir), JSON.stringify(hold), 'utf8')
}

export function readValidHold(profileDir: string, now: number, pidLives: (pid: number) => boolean): UpdateHold | null {
  let parsed: Partial<UpdateHold>
  try {
    parsed = JSON.parse(readFileSync(holdPath(profileDir), 'utf8')) as Partial<UpdateHold>
  } catch {
    return null
  }
  if (typeof parsed.pid !== 'number' || typeof parsed.until !== 'number') return null
  if (now > parsed.until || !pidLives(parsed.pid)) return null
  return { pid: parsed.pid, until: parsed.until }
}

export function clearUpdateHold(profileDir: string): void {
  rmSync(holdPath(profileDir), { force: true })
}
