// Installs the discovery stub.
//
// **Why this exists**: there was no path by which the feature could be discovered. Nothing in the
// repo read or copied `resources/skills/orchestration-stub.md`, so an orchestrator agent had no way
// to learn that `astera` existed — the user had to spell it out every time. Putting a stub in the
// skills directory lets the agent read its own skill list at session start and find "use this when
// supervision, completion tracking, or dependency decomposition is needed".
//
// Why not inject a first prompt instead: `initialPrompt` pushes a prompt into the session, which
// makes the agent **start a turn immediately**. Polluting the first turn of every user session is far
// more invasive than adding a file.
//
// Why this is a separate module outside the registerIpc closure: inside it, this could not be tested
// without Electron (the same call made for release.ts).
//
// **Installed for both claude and codex**, at the same path —
// `<configDir>/skills/astera-orchestration/SKILL.md`. The codex side was verified by testing:
// `~/.codex/skills/` exists and has a `.system` subdirectory (whereas `~/.codex/prompts` does not),
// codex recognises this file as a skill, and it can also be invoked as `/astera-orchestration` — the
// format matches codex's own system skills (codex quotes `name` and `description`, which is
// equivalent in YAML). Skills load at session start, so the stub does not appear in sessions that
// were already open before installation.
// **`AGENTS.md` is left alone** — that is a user file and would need its own decision.
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Marks the file as owned by the app. It sits in the first line of the body of
 *  `resources/skills/orchestration-stub.md`, and when a target file lacks it the file is **left
 *  untouched** (see installStub below).
 *
 *  Why after the front matter rather than before it: a skill file must start with its YAML front
 *  matter for the loader to register it. A comment in front makes registration fail silently, which
 *  removes the very discovery path this stub exists to provide. Detection is by containment, not
 *  position, so the first line of the body is enough. */
export const STUB_MARKER = 'managed by Astera'

/** The content with the **whole marker comment block** removed. **Deciding ownership from the marker
 *  alone makes the app lock itself out of its own files** — a stub written by a build from before the
 *  marker existed has none, and treating that file as a user skill blocks the update path forever
 *  (observed on a real machine: three unmarked stubs were skipped on every subsequent launch). So a
 *  file with no marker still counts as ours **when its content minus the marker matches the current
 *  stub**.
 *
 *  **A line filter is not enough** (reproduced by running it): the real marker is an HTML comment
 *  **spanning several lines** and `STUB_MARKER` only appears on its first line. Dropping just that
 *  line leaves the second line and the blank line after the comment behind, so the result can
 *  **never** match a pre-marker file — meaning those three kept being skipped even when there was an
 *  update. The comment span and the blank lines following it have to go together for the comparison
 *  to hold.
 *
 *  Line endings are normalised too: if this resource ever gets saved as CRLF (an editor or build
 *  pipeline change), the same class of permanent skip comes back. This function is comparison-only,
 *  so normalising here does not affect file content. */
const withoutMarker = (s: string): string =>
  s
    .replace(/\r\n/g, '\n')
    // Only the comment holding the marker is dropped — other HTML comments may be part of the stub
    // body and are preserved. The `\n*` absorbs the blank lines after the comment, without which the
    // bytes cannot match a pre-marker file.
    .replace(/<!--[\s\S]*?-->\n*/g, (m) => (m.includes(STUB_MARKER) ? '' : m))

/** Install location under an account's configDir. `.claude` is not hardcoded — per-account
 *  CLAUDE_CONFIG_DIR (CODEX_HOME for codex) isolation is the whole reason this app exists.
 *
 *  The directory is namespaced to this app rather than a bare `orchestration`: the path lives in the
 *  user's shared config directory, so a generic name would collide with any other tool that installs
 *  an orchestration skill there. Two apps fighting over one file is a silent failure — whichever
 *  wrote last owns it, and the loser's install is skipped forever by the ownership check below. */
export const stubTargetPath = (configDir: string): string =>
  path.join(configDir, 'skills', 'astera-orchestration', 'SKILL.md')

/**
 * Installs the stub into each account's skills directory.
 *
 * - **Only files the app owns are overwritten.** There are two grounds for ownership and **either one
 *   is enough**: ① `STUB_MARKER` is present (everything written from now on qualifies) ② the content
 *   matches the current resource's stub once the marker line is removed (a file written by a build
 *   from before the marker, or an older file from before the marker wording changed). If neither
 *   holds, the file is **left alone and only logged**. The default account's configDir is the real
 *   `~/.claude`, so without this boundary the app would silently delete the user's own skills.
 *
 *   **A deliberate limit of ②**: the comparison is against the **current** resource stub, so a stub
 *   written by an older version of the app does not match. Catching those too would mean carrying the
 *   stub's history around, which is too much. Instead the skip log **does not overclaim**: all it
 *   knows is "no marker, and it does not match the current stub", so it states that and the path, and
 *   leaves the judgement to the user.
 * - If it is our file, it gets overwritten — the stub is app-owned and versioned. Identical content is
 *   not rewritten though (a pointless file update wakes the user's file watchers).
 * - **It never throws.** A failed install must not stop orchestration from starting (the feature works
 *   without the skill as long as the user gives directions). One account failing does not stop the rest.
 * - Nothing is deleted when the toggle goes off — that would be deleting a user file, and leaving it
 *   is harmless because the stub's "check the tooling" step reports that `$ASTERA_CLI` is empty.
 */
export async function installStub(a: {
  /** Absolute path to resources/skills/orchestration-stub.md */
  stubPath: string
  /** configDirs of the target accounts (both claude and codex) */
  configDirs: string[]
  log?: (message: string) => void
}): Promise<{ written: string[]; unchanged: string[]; skipped: string[]; failed: string[] }> {
  const result = {
    written: [] as string[],
    unchanged: [] as string[],
    skipped: [] as string[],
    failed: [] as string[]
  }
  let content: string
  try {
    content = await fs.readFile(a.stubPath, 'utf8')
  } catch (err) {
    a.log?.(`stub install skipped — could not read the source ${a.stubPath}: ${String(err)}`)
    return result
  }
  // If the source has no marker, the files we write would look like someone else's on the next
  // launch. Installing in that state stops updates forever, so nothing is done and it is reported
  // (this guards against an accidental edit to the stub during development).
  if (!content.includes(STUB_MARKER)) {
    a.log?.(`stub install skipped — the source carries no ownership marker ${a.stubPath}`)
    return result
  }
  for (const configDir of a.configDirs) {
    const target = stubTargetPath(configDir)
    try {
      const existing = await fs.readFile(target, 'utf8').catch(() => null)
      const appOwned =
        existing === null ||
        existing.includes(STUB_MARKER) ||
        withoutMarker(existing) === withoutMarker(content)
      if (!appOwned) {
        result.skipped.push(target)
        // Does not overclaim: we cannot assert the app did not create it (it may be a stub from an
        // older version). State only what is known and leave the path as evidence for the user.
        a.log?.(
          `stub install skipped — no ownership marker and content differs from the current stub ${target}`
        )
        continue
      }
      if (existing === content) {
        result.unchanged.push(target)
        continue
      }
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, content, 'utf8')
      result.written.push(target)
    } catch (err) {
      result.failed.push(target)
      a.log?.(`stub install failed ${target}: ${String(err)}`)
    }
  }
  return result
}
