// Builds the GitHub release notes for a tag from the commits it introduced.
//
// GitHub's own `--generate-notes` assembles its list out of pull requests. This repository commits
// straight to the branch, so that produces nothing but a "Full Changelog" link — which is what every
// release up to v1.0.3 shipped with.
//
// **The unit is the branch, not the commit.** A line per commit made a release that added one
// feature read as twenty separate things (v1.3.12), or scroll for a hundred lines (v1.3.10). Work
// already arrives as a branch merged into develop, and that branch IS what a reader means by "a
// feature" — so each one is a single line, its commits kept in a collapsed section underneath. A
// commit pushed straight to develop has no branch to belong to and keeps a line of its own.
//
// **`docs/release-notes/<tag>.md` wins when it exists**, replacing the two generated sections. It is
// written just before the tag by an agent that has read the whole release, which is the only way to
// get past what a branch name cannot say: a real sentence about what changed, and the split of a
// branch that carried two user-visible things (v1.3.12's goal work and its record titles rode the
// same one). Without the file everything below generates as before, so a release cut without one is
// still complete — see docs/releasing.md.
//
// The body reads in this order: what the release adds, what it fixes, every change (collapsed), then
// the install caveats. The caveats go LAST because GitHub renders the asset list below the body — at
// the end they sit on the way to the download, whereas at the top (where they used to be) they
// pushed the changes off the screen.
//
// Everything is ordered oldest-first, the order the work landed, so a branch reads before the ones
// built on top of it.
//
// Prints markdown to stdout.
//
// Usage: node scripts/build-release-notes.cjs <tag>
// Env:   MAC_SIGNED=true drops the Gatekeeper caveat. release.yml sets it from the Apple secrets.
const { execFileSync } = require('child_process')
const fs = require('fs')

const tag = process.argv[2]
if (!tag) {
  console.error('usage: node scripts/build-release-notes.cjs <tag>')
  process.exit(2)
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const lines = (s) => s.split('\n').filter(Boolean)

// The tag before this one. Absent on the very first release, where every commit belongs to it.
let previous = null
try {
  previous = git('describe', '--tags', '--abbrev=0', `${tag}^`)
} catch {
  previous = null
}

const range = previous ? `${previous}..${tag}` : tag

// ---- the commits in this release ---------------------------------------------------------------

const CONVENTIONAL = /^(\w+)(?:\(([^)]*)\))?!?: (.+)$/
// The release's own version commit. Dropped outright rather than collapsed: it IS the release, and
// it says nothing the tag at the top of the page does not.
const VERSION_BUMP = /^chore:\s*v\d+\.\d+\.\d+$/

// %x00 rather than a printable separator: a commit subject can contain any of those.
const commits = lines(git('log', '--no-merges', '--format=%h%x00%s', range))
  .map((line) => {
    const [hash, subject] = line.split('\0')
    const parsed = CONVENTIONAL.exec(subject)
    return {
      hash,
      subject,
      type: parsed ? parsed[1] : null,
      scope: parsed ? parsed[2] : null,
      text: parsed ? parsed[3] : subject
    }
  })
  .filter((c) => !VERSION_BUMP.test(c.subject))
  .reverse() // oldest first

// ---- the branches those commits arrived on -----------------------------------------------------

// Git's default merge subject. `Merge branch 'develop' into main for v1.3.12` matches it too, which
// is what lets the release merges be recognised and skipped.
const MERGE_SUBJECT = /^Merge branch '([^']+)'/
// Merging one long-lived branch into another moves work along; it does not introduce any.
const INTEGRATION = /^(develop|main|master)$/

const merges = lines(git('log', '--merges', '--format=%h%x00%P%x00%s', range))
  .map((line) => {
    const [hash, parents, subject] = line.split('\0')
    const named = MERGE_SUBJECT.exec(subject)
    return { hash, parents: parents.split(' '), subject, branch: named ? named[1] : null }
  })
  .filter((m) => m.parents.length === 2 && !(m.branch && INTEGRATION.test(m.branch)))
  .reverse() // oldest first

// `M^1..M^2` is exactly what the second parent brought in — the branch, and nothing else.
for (const m of merges) {
  const span = `${m.parents[0]}..${m.parents[1]}`
  m.reachable = new Set(lines(git('rev-list', '--abbrev-commit', span)))
  m.commits = commits.filter((c) => m.reachable.has(c.hash))
}

// A branch merged into another branch is not a unit of its own — the outer one already carries it.
const nested = new Set()
for (const a of merges) {
  for (const b of merges) if (a !== b && b.reachable.has(a.hash)) nested.add(a.hash)
}
const branches = merges.filter((m) => !nested.has(m.hash) && m.commits.length > 0)

const claimed = new Set(branches.flatMap((b) => b.commits.map((c) => c.hash)))
const loose = commits.filter((c) => !claimed.has(c.hash))

// ---- naming and sorting the units --------------------------------------------------------------

// The branch prefix says what the branch was for, and it is more reliable than its commits: every
// commit on feat/goal-close-previous is a `fix:`, because they were iterating on a feature that had
// not shipped yet. A branch with no recognised prefix falls back to what its commits say.
const BY_PREFIX = { feat: 'feat', feature: 'feat', fix: 'fix', bugfix: 'fix', hotfix: 'fix' }
const sectionOf = (b) => {
  const prefix = b.branch && BY_PREFIX[b.branch.split('/')[0]]
  if (prefix) return prefix
  if (b.commits.some((c) => c.type === 'feat')) return 'feat'
  if (b.commits.some((c) => c.type === 'fix')) return 'fix'
  return 'rest'
}

// A merge message written by hand wins: it names the work better than a branch name ever will, and
// it costs one line at merge time rather than a release note per release. Without one, what is left
// is the branch name with its prefix stripped and its hyphens opened out.
const titleOf = (b) => {
  if (!b.branch || !/^Merge branch '/.test(b.subject)) return b.subject
  const name = b.branch.slice(b.branch.lastIndexOf('/') + 1).replace(/[-_]+/g, ' ')
  return name.charAt(0).toUpperCase() + name.slice(1)
}

// Loose commits have no branch to be grouped by, so the same-release rule still earns its keep for
// them: a `fix(scope)` alongside a `feat(scope)` in this release fixed code nobody has run yet.
// Unscoped fixes are never demoted — there is nothing to match them on, and leaving a real fix
// visible is the safer error.
const looseFeat = loose.filter((c) => c.type === 'feat')
const looseFeatScopes = new Set(looseFeat.map((c) => c.scope).filter(Boolean))
const looseFix = loose.filter((c) => c.type === 'fix' && !(c.scope && looseFeatScopes.has(c.scope)))

const commitLine = (c) => `* ${c.text} (${c.hash})`
const unitLine = (b) =>
  `* **${titleOf(b)}** (${b.commits.length} commit${b.commits.length === 1 ? '' : 's'})`
const section = (kind, looseCommits) => [
  ...branches.filter((b) => sectionOf(b) === kind).map(unitLine),
  ...looseCommits.map(commitLine)
]

// ---- install caveats ---------------------------------------------------------------------------

// Dropped on its own once the build is notarized, since release.yml then sets MAC_SIGNED.
const MACOS_UNNOTARIZED =
  '**macOS** — the build is not notarized yet. It is ad-hoc signed, so it runs on Apple Silicon, ' +
  'but Gatekeeper blocks the first launch: after dragging the app to Applications, clear the ' +
  'quarantine flag with `xattr -cr /Applications/Astera.app`. **System Settings → Privacy & ' +
  'Security → Open Anyway** works too. Auto-update stays off on macOS until the build is notarized, ' +
  'so a new version means downloading the dmg from this page again. The Windows installer is ' +
  'unaffected.'

// Unconditional: it describes how these artifacts are installed, not a state the project is
// passing through.
const LINUX_INSTALL =
  '**Linux** — the AppImage needs the executable bit before it will run: `chmod +x` the file you ' +
  'downloaded. The deb installs with `sudo apt install ./<file>.deb`, which pulls its dependencies; ' +
  '`dpkg -i` on its own does not. The supported floor is Ubuntu 22.04 / Debian 12, and the deb ' +
  'declares it, so apt refuses an older system rather than installing something that cannot start.'

// Windows builds up to and including v1.1.0 shipped without resources/app-update.yml, so on those
// installs the update check, the update button and the campaign notice all fail — every in-app
// channel reads that same file. The release page is the only way left to reach those users, which is
// why this rides on every release rather than sitting in a campaign.
// REMOVE once the pre-1.1.1 installs have had time to move over.
const WINDOWS_STRANDED =
  '**Windows 1.1.0 or earlier** — this one has to be installed by hand. Those builds shipped ' +
  'without the file the updater reads to find releases, so their update check fails and no notice ' +
  'from inside the app can reach you. Download the installer below and run it — whatever you ' +
  'install from here on updates itself normally.'

const caveats = [
  process.env.MAC_SIGNED === 'true' ? null : MACOS_UNNOTARIZED,
  LINUX_INSTALL,
  WINDOWS_STRANDED
].filter(Boolean)

// ---- assembly ----------------------------------------------------------------------------------

const out = []

// Written up by an agent before the tag, and committed, so it is here in the checkout the publish
// job makes at that tag. It stands in for both generated sections — not alongside them, or the same
// work would be described twice.
const writeUp = `docs/release-notes/${tag}.md`
if (fs.existsSync(writeUp)) {
  out.push(fs.readFileSync(writeUp, 'utf8').trim())
} else {
  const features = section('feat', looseFeat)
  if (features.length) out.push(`## New features\n\n${features.join('\n')}`)

  const fixes = section('fix', looseFix)
  if (fixes.length) out.push(`## Fixes\n\n${fixes.join('\n')}`)
}

// One place holding everything, so nothing above has to pretend a commit does not exist — docs, ci,
// refactor and test included, and any subject that does not parse as a conventional commit.
if (commits.length) {
  const groups = [
    ...branches.map((b) => `**${titleOf(b)}**\n\n${b.commits.map(commitLine).join('\n')}`),
    loose.length ? `**Not on a branch**\n\n${loose.map(commitLine).join('\n')}` : null
  ].filter(Boolean)
  out.push(
    `<details>\n<summary>Every change (${commits.length})</summary>\n\n` +
      `${groups.join('\n\n')}\n</details>`
  )
}

out.push(`## Installing\n\n${caveats.join('\n\n')}`)

// GITHUB_REPOSITORY is set by Actions; fall back to package.json so the script runs locally too.
const repo =
  process.env.GITHUB_REPOSITORY ||
  (JSON.parse(fs.readFileSync('package.json', 'utf8')).repository?.url ?? '')
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace('https://github.com/', '')

if (repo) {
  const link = previous
    ? `https://github.com/${repo}/compare/${previous}...${tag}`
    : `https://github.com/${repo}/commits/${tag}`
  out.push(`**Full Changelog**: ${link}`)
}

console.log(out.join('\n\n'))
