import { promises as fs } from 'node:fs'
import path from 'node:path'
import { COMPOSE_FILE_NAMES, parseComposeServices } from '../core/run/compose'

/** The service names in a project's compose file — feeds RunConfigForm's "candidate hint" under the
 *  services text field.
 *
 *  Checks COMPOSE_FILE_NAMES in priority order and reads the first one found; parseComposeServices does
 *  the (deliberately shallow) parsing. Unlike jdkScanner/pythonScanner there is no execFile step and
 *  nothing worth caching — this is one fs.readFile of a small text file, not a subprocess scan.
 *
 *  Returns [] when no compose file exists or the first one found cannot be read — same contract as
 *  pythonScanner's verify(): a scan failure just empties the hint, it never throws up to the IPC
 *  caller. */
export async function listComposeServices(projectPath: string): Promise<string[]> {
  for (const name of COMPOSE_FILE_NAMES) {
    let text: string
    try {
      text = await fs.readFile(path.join(projectPath, name), 'utf8')
    } catch {
      continue // this candidate name does not exist here — try the next
    }
    return parseComposeServices(text)
  }
  return []
}
