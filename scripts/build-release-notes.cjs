// Builds the GitHub release notes for a tag from the commits it introduced.
//
// GitHub's own `--generate-notes` assembles its list out of pull requests. This repository commits
// straight to the branch, so that produces nothing but a "Full Changelog" link — which is what every
// release up to v1.0.3 shipped with. The commit subjects carry the same information, since they
// follow conventional commits, so this groups them by type instead.
//
// Anything that is not a feat or a fix (docs, ci, chore, refactor) goes into a collapsed section
// rather than being dropped: it keeps the list readable without pretending those commits do not
// exist. Subjects that do not parse as conventional commits are kept verbatim in the same place.
//
// Prints markdown to stdout.
//
// Usage: node scripts/build-release-notes.cjs <tag>
const { execFileSync } = require('child_process')
const fs = require('fs')

const tag = process.argv[2]
if (!tag) {
  console.error('usage: node scripts/build-release-notes.cjs <tag>')
  process.exit(2)
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

// The tag before this one. Absent on the very first release, where every commit belongs to it.
let previous = null
try {
  previous = git('describe', '--tags', '--abbrev=0', `${tag}^`)
} catch {
  previous = null
}

// %x00 rather than a printable separator: a commit subject can contain any of those.
const range = previous ? `${previous}..${tag}` : tag
const log = git('log', '--no-merges', '--format=%s%x00%h', range)

const CONVENTIONAL = /^(\w+)(?:\([^)]*\))?!?: (.+)$/
const commits = log
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [subject, hash] = line.split('\0')
    const parsed = CONVENTIONAL.exec(subject)
    return { type: parsed ? parsed[1] : null, text: parsed ? parsed[2] : subject, hash }
  })

const entry = (c) => `* ${c.text} (${c.hash})`
const take = (...types) => commits.filter((c) => types.includes(c.type))

const features = take('feat')
const fixes = take('fix')
const rest = commits.filter((c) => c.type !== 'feat' && c.type !== 'fix')

// Windows builds up to and including v1.1.0 shipped without resources/app-update.yml, so on those
// installs the update check, the update button and the campaign notice all fail — every in-app
// channel reads that same file. The release page is the only way left to reach those users, which is
// why this sits at the top of every release note rather than in a campaign.
// REMOVE once the pre-1.1.1 installs have had time to move over.
const STRANDED_WINDOWS_NOTICE =
  '> **On Windows 1.1.0 or earlier? This one has to be installed by hand.** Those builds shipped ' +
  'without the file the updater reads to find releases, so their update check fails and no notice ' +
  'from inside the app can reach you. Download the installer below and run it — whatever you ' +
  'install from here on updates itself normally.'

const out = [STRANDED_WINDOWS_NOTICE]
if (features.length) out.push(`## New features\n\n${features.map(entry).join('\n')}`)
if (fixes.length) out.push(`## Fixes\n\n${fixes.map(entry).join('\n')}`)
if (rest.length) {
  out.push(
    `<details>\n<summary>Other changes (${rest.length})</summary>\n\n` +
      `${rest.map(entry).join('\n')}\n</details>`
  )
}

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
