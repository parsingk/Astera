// Regenerates the auto-update metadata after the installer file has been modified.
//
// Code signing appends a certificate table to the installer, which changes its bytes. latest.yml
// (the electron-updater feed) carries the installer's sha512 and size, and the .blockmap used for
// differential downloads is derived from the file's contents — all three were computed by
// electron-builder from the UNSIGNED installer, so after signing every one of them is stale. An
// updater that downloaded the signed file would then fail the sha512 check and reject the update.
//
// This rebuilds the .blockmap from the file as it exists now and rewrites the sha512/size fields in
// latest.yml to match. Uses electron-builder's own blockmap implementation, so the output is
// byte-identical to what a normal build produces (verified against an untouched installer).
//
// Usage: node scripts/patch-update-feed.cjs <setup.exe> <latest.yml>
const path = require('path')
const fs = require('fs')
const { buildBlockMap } = require(
  path.join(process.cwd(), 'node_modules/app-builder-lib/out/targets/blockmap/blockmap')
)

const installer = process.argv[2]
const feed = process.argv[3]
if (!installer || !feed) {
  console.error('usage: node scripts/patch-update-feed.cjs <setup.exe> <latest.yml>')
  process.exit(2)
}

buildBlockMap(installer, 'gzip', `${installer}.blockmap`)
  .then((info) => {
    let text = fs.readFileSync(feed, 'utf8')
    // The old sha512 appears twice (files[0].sha512 and the top-level path/sha512 pair) with the
    // same value; split/join replaces both without needing to parse YAML.
    const oldSha = /sha512: (\S+)/.exec(text)?.[1]
    if (!oldSha) throw new Error(`${feed} has no sha512 field`)
    text = text.split(oldSha).join(info.sha512)
    text = text.replace(/size: \d+/g, `size: ${info.size}`)
    fs.writeFileSync(feed, text)
    console.log(`patched ${feed}: sha512=${info.sha512.slice(0, 20)}… size=${info.size}`)
  })
  .catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
