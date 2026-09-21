/**
 * The macOS fallback for when Squirrel.Mac refuses the update it was handed.
 *
 * **Why this exists.** An update is installed on macOS by Squirrel.Mac, which validates the new
 * app against the *running* app's designated requirement before it will swap it in. A release
 * signed with a Developer ID has a certificate-based requirement, and a new build satisfies it.
 * A release signed ad-hoc — what the release workflow falls back to when the Apple secrets are
 * not configured (.github/workflows/release.yml, "Build ad-hoc signed package") — has no
 * certificate, so its requirement degenerates into a literal list of this binary's own cdhashes:
 *
 *     designated => cdhash H"8fdbf953…" or cdhash H"bb03438f…"
 *
 * Any new build has different hashes by definition, so it can never satisfy it. Auto-update on
 * that channel is not flaky, it is impossible, and it fails the same way every time:
 *
 *     Code signature at URL file:///…/ShipIt/update.…/Astera.app/ did not pass validation
 *
 * **What made it silent.** electron-updater announces `update-downloaded` *before* Squirrel has
 * validated anything (MacUpdater.js dispatches the event, then calls the native checkForUpdates on
 * the next line), so the app offers an install button for a build Squirrel has already rejected a
 * second later. Pressing it reaches `quitAndInstall`, which finds nothing staged, asks Squirrel
 * again, gets the same refusal — and the app simply does not quit. Nothing on screen, nothing
 * pressed twice would fix.
 *
 * So this module does two things. `reduceStaging` tells "downloaded" apart from "installable" by
 * watching the native updater directly, and `extractForManualInstall` turns the already-downloaded,
 * already-checksummed zip into an app the person can drag into /Applications themselves.
 *
 * Nothing here imports electron: the decisions are the part worth testing, and a test run cannot
 * load electron.
 */

import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * What is known about the update that was downloaded.
 *
 * `downloaded` is electron-updater's word, `staged` is Squirrel's. The gap between them is the
 * whole point: only `staged` means `quitAndInstall` will actually do something.
 */
export type StagingState = {
  downloaded: boolean
  staged: boolean
  /** Squirrel's reason for refusing, once there is one. */
  refused: string | null
}

export const NOTHING_STAGED: StagingState = { downloaded: false, staged: false, refused: null }

export type StagingEvent =
  /** A check began — see reduceStaging for why this resets everything. */
  | { type: 'check' }
  /** electron-updater has the file and has verified its checksum. */
  | { type: 'downloaded' }
  /** The native (Squirrel) updater accepted it. This is the one that means installable. */
  | { type: 'staged' }
  /** The native updater reported an error. */
  | { type: 'error'; message: string }

/**
 * Folds the updater's events into a verdict on the downloaded build.
 *
 * Two of the rules are less obvious than they look. An error *before* anything was downloaded is
 * not a refusal — it is a feed or network failure, and treating it as one would send the person
 * down the manual path with no file to install. And a check resets the verdict outright, because
 * with autoDownload on, a check that finds a newer version replaces the staged file; the previous
 * refusal was about a build that is no longer the candidate.
 */
export function reduceStaging(state: StagingState, event: StagingEvent): StagingState {
  switch (event.type) {
    case 'check':
      return NOTHING_STAGED
    case 'downloaded':
      return { downloaded: true, staged: false, refused: null }
    case 'staged':
      return { ...state, staged: true, refused: null }
    case 'error':
      // Only a download that Squirrel then turned down is a refusal. Once it has been accepted,
      // later noise from the native updater does not unstage a build that is ready to install.
      if (!state.downloaded || state.staged) return state
      return { ...state, refused: event.message }
  }
}

/**
 * Which install path the button takes.
 *
 * macOS only: Windows installs through NSIS, which has no equivalent failure and no drag-to-install
 * gesture to fall back on, and Linux ships through AppImage/deb where the app never installs itself.
 */
export function installRoute(platform: NodeJS.Platform, staging: StagingState): 'auto' | 'manual' {
  return platform === 'darwin' && staging.refused !== null ? 'manual' : 'auto'
}

/**
 * Where the extracted app goes: a sibling of electron-updater's own `pending` directory.
 *
 * Inside the updater's cache rather than a temp directory on purpose — the app quits right after
 * revealing the file, and the person drags it some seconds later, so the directory has to outlive
 * the process that made it. Keying it by version means a later update's extraction does not land
 * on top of one still sitting in Finder.
 */
export function manualInstallDir(downloadedFile: string, version: string): string {
  return path.join(path.dirname(path.dirname(downloadedFile)), 'manual', version)
}

/** The filesystem and process work, behind a seam so the ordering above can be tested without macOS. */
export type ManualInstallIO = {
  rm(dir: string): Promise<void>
  mkdir(dir: string): Promise<void>
  run(file: string, args: string[]): Promise<void>
  list(dir: string): Promise<string[]>
}

export const nodeManualInstallIO: ManualInstallIO = {
  rm: (dir) => fs.rm(dir, { recursive: true, force: true }),
  mkdir: async (dir) => void (await fs.mkdir(dir, { recursive: true })),
  run: async (file, args) => void (await execFileAsync(file, args)),
  list: (dir) => fs.readdir(dir)
}

/**
 * Unpacks the downloaded zip into a folder the person can drag from, and returns the app's path.
 *
 * The zip is the one electron-updater already downloaded and verified against the sha512 in the
 * feed, so nothing is fetched again — the 226 MB is already on disk by the time the button is
 * pressed, because autoDownload is on.
 *
 * **The `xattr` step is the point, not housekeeping.** Extracting a zip that carries
 * `com.apple.quarantine` spreads the attribute over every file that comes out of it (measured), and
 * Gatekeeper then refuses to launch an ad-hoc-signed build — which is exactly the state that had
 * people running `xattr -cr /Applications/Astera.app` in a terminal after installing by hand. Doing
 * it here means they never have to. `xattr -dr` exits 0 whether or not the attribute is present, so
 * it is safe on the ordinary path where the in-app download was never quarantined at all.
 */
export async function extractForManualInstall(opts: {
  downloadedFile: string
  version: string
  io?: ManualInstallIO
}): Promise<string> {
  const io = opts.io ?? nodeManualInstallIO
  const dest = manualInstallDir(opts.downloadedFile, opts.version)

  await io.rm(dest) // an earlier attempt, or an interrupted one, must not be mistaken for this one
  await io.mkdir(dest)
  await io.run('ditto', ['-xk', opts.downloadedFile, dest])
  await io.run('xattr', ['-dr', 'com.apple.quarantine', dest])

  const app = (await io.list(dest)).find((e) => e.endsWith('.app'))
  if (!app) throw new Error(`no .app found in ${dest} after extracting ${opts.downloadedFile}`)
  return path.join(dest, app)
}
