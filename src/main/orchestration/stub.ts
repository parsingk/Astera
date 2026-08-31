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

/** The marker the app wrote before the claude-manager → Astera rebrand (`managed by claude-manager
 *  (SERVER-3004)`). Only ever used to recognise a file as **ours to remove** — nothing is written with
 *  it. Matching on `STUB_MARKER` alone would find none of the leftovers: every stub installed before
 *  the rebrand carries this wording instead (seven of them on the machine this was diagnosed on). */
export const LEGACY_STUB_MARKER = 'managed by claude-manager'

/** Skill directory names this app installed the stub under in earlier versions. `orchestration` is
 *  the pre-rebrand name, from when the CLI was `cm-orch` and the environment variable `CM_ORCH_CLI`.
 *
 *  Why they have to be cleaned up rather than just left: the front matter of the old and the new stub
 *  carry the **same `description`**, so both load as skills and the agent picks one of the two. When
 *  it picks the old one it follows that file's first step — `echo "$CM_ORCH_CLI"` and `cm-orch help` —
 *  and both come back empty, because the app now plants `ASTERA_CLI` and names the shuttle `astera`.
 *  The agent then reports that orchestration is off while it is running perfectly. Renaming without
 *  removing turns a rename into a permanent misdiagnosis. */
const LEGACY_STUB_DIRS = ['orchestration']

/** Where earlier versions installed the stub under a configDir. Cleanup targets, one per old name. */
export const legacyStubPaths = (configDir: string): string[] =>
  LEGACY_STUB_DIRS.map((name) => path.join(configDir, 'skills', name, 'SKILL.md'))

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

/** The skill directory name identifying the orchestration stub. It is the one stub old installs
 *  ever used a different directory name for (see LEGACY_STUB_DIRS), so it is also what installStub
 *  uses below to scope legacy cleanup to that stub only. */
const ORCHESTRATION_SKILL_NAME = 'astera-orchestration'

/** Install location under an account's configDir. `.claude` is not hardcoded — per-account
 *  CLAUDE_CONFIG_DIR (CODEX_HOME for codex) isolation is the whole reason this app exists.
 *
 *  The directory is namespaced to this app rather than a bare `orchestration`: the path lives in the
 *  user's shared config directory, so a generic name would collide with any other tool that installs
 *  an orchestration skill there. Two apps fighting over one file is a silent failure — whichever
 *  wrote last owns it, and the loser's install is skipped forever by the ownership check below. */
export const stubTargetPath = (configDir: string, skillName: string = ORCHESTRATION_SKILL_NAME): string =>
  path.join(configDir, 'skills', skillName, 'SKILL.md')

/**
 * Installs one or more stubs into each account's skills directory.
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
 *   without the skill as long as the user gives directions). One account failing does not stop the
 *   rest, and — now that this installs a list — one stub failing does not stop the others either:
 *   every rule above (the ownership marker, the legacy-removal rule, "leave a file we do not own
 *   alone") is judged per stub and per account, independently.
 * - Nothing is deleted when the toggle goes off — that would be deleting a user file, and leaving it
 *   is harmless because the stub's "check the tooling" step reports that `$ASTERA_CLI` is empty.
 * - **The stub this app installed under an old name is removed** (see LEGACY_STUB_DIRS for why a
 *   leftover is worse than harmless). Ownership is judged the same way, widened by
 *   `LEGACY_STUB_MARKER`; a file without either marker is left alone and only logged. Removal happens
 *   **only once the current stub is confirmed in place** for that account — deleting the old one after
 *   a failed install would leave the account with no orchestration skill at all, which is worse than
 *   a stale one. This is scoped to the orchestration stub alone (see ORCHESTRATION_SKILL_NAME) —
 *   `LEGACY_STUB_DIRS` names directories only that stub ever used.
 */
export async function installStub(a: {
  /** Each stub and the skill directory name it installs under. The app owns both files; the
   *  ownership marker, the legacy-removal rule and the "leave a file we do not own alone" rule
   *  are per stub, not per account. */
  stubs: { stubPath: string; skillName: string }[]
  /** configDirs of the target accounts (both claude and codex) */
  configDirs: string[]
  log?: (message: string) => void
}): Promise<{
  written: string[]
  unchanged: string[]
  skipped: string[]
  failed: string[]
  removed: string[]
}> {
  const result = {
    written: [] as string[],
    unchanged: [] as string[],
    skipped: [] as string[],
    failed: [] as string[],
    removed: [] as string[]
  }
  for (const stub of a.stubs) {
    let content: string
    try {
      content = await fs.readFile(stub.stubPath, 'utf8')
    } catch (err) {
      a.log?.(`stub install skipped — could not read the source ${stub.stubPath}: ${String(err)}`)
      continue
    }
    // If the source has no marker, the files we write would look like someone else's on the next
    // launch. Installing in that state stops updates forever, so nothing is done and it is reported
    // (this guards against an accidental edit to the stub during development).
    if (!content.includes(STUB_MARKER)) {
      a.log?.(`stub install skipped — the source carries no ownership marker ${stub.stubPath}`)
      continue
    }
    for (const configDir of a.configDirs) {
      const target = stubTargetPath(configDir, stub.skillName)
      // Whether this account ends the round with the current stub on disk — the precondition for
      // touching the old one. `continue` is deliberately not used below: `unchanged` is the second-launch
      // path and has to reach the cleanup too, or a leftover would survive every launch after the first.
      let inPlace = false
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
        } else if (existing === content) {
          result.unchanged.push(target)
          inPlace = true
        } else {
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.writeFile(target, content, 'utf8')
          result.written.push(target)
          inPlace = true
        }
      } catch (err) {
        result.failed.push(target)
        a.log?.(`stub install failed ${target}: ${String(err)}`)
      }
      // Scoped to the orchestration stub only — LEGACY_STUB_DIRS names directories that only that
      // stub ever used, so a task-stub install (or any future stub) must never touch them.
      if (inPlace && stub.skillName === ORCHESTRATION_SKILL_NAME) {
        result.removed.push(...(await removeLegacyStubs(configDir, a.log)))
      }
    }
  }
  return result
}

/**
 * Deletes the stubs this app installed under an old name in one account, and returns what was deleted.
 *
 * Never throws — a failed removal is logged and the round continues, the same rule the install path
 * follows. A file carrying neither marker is somebody else's and is left alone; unlike the install
 * path there is no content-comparison fallback, because the content to compare against would be the
 * old stub's, and carrying the stub's history around is what that path already refused to do. An
 * unmarked leftover therefore stays — visible, and reported.
 */
async function removeLegacyStubs(
  configDir: string,
  log?: (message: string) => void
): Promise<string[]> {
  const removed: string[] = []
  for (const p of legacyStubPaths(configDir)) {
    const existing = await fs.readFile(p, 'utf8').catch(() => null)
    if (existing === null) continue // nothing there — the normal case after the first cleanup
    if (!existing.includes(STUB_MARKER) && !existing.includes(LEGACY_STUB_MARKER)) {
      log?.(`legacy stub kept — no ownership marker ${p}`)
      continue
    }
    try {
      await fs.unlink(p)
      removed.push(p)
      // rmdir, not rm -r: it fails on a non-empty directory, which is exactly the guard we want —
      // anything else the user left in there keeps the directory alive.
      await fs.rmdir(path.dirname(p)).catch(() => {})
    } catch (err) {
      log?.(`legacy stub removal failed ${p}: ${String(err)}`)
    }
  }
  return removed
}
