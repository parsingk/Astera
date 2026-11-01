// What this computer says of a paired Runtime beside its own state (remote governance design §9.3, §10.1).
import { atLeast, parseCliVersion } from '../sessions/cliVersion'

/** Whether the Runtime's Astera is older than this one's, part by part as numbers. A version either side that does not
 *  read is never taken for older: §9.3 advises, and a guess would advise wrongly. */
export function runtimeIsOlder(there: string, here: string): boolean {
  const a = parseCliVersion(there)
  const b = parseCliVersion(here)
  return a !== null && b !== null && !atLeast(a, b)
}
