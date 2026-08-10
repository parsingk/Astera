# Releasing

Astera is released by **pushing a `vX.Y.Z` tag**. That triggers
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which builds the Windows
installer and the macOS universal package, publishes both to GitHub Releases, and installed apps
then update themselves through `electron-updater`.

## Procedure

1. **Pick the version (semver)** — bump `version` in `package.json`. It **must be higher than the
   previous one**, or electron-updater will not treat it as an update.
   - `patch` (1.0.0 → 1.0.1): bug fixes
   - `minor` (1.0.0 → 1.1.0): backwards-compatible additions
   - `major` (1.0.0 → 2.0.0): breaking changes

2. **Commit** the version change.
   ```bash
   git commit -am "chore: v1.0.1"
   ```

3. **Tag and push.** The tag must be `v` plus the `package.json` version, **exactly**.
   ```bash
   git tag v1.0.1
   git push origin main --tags
   ```
   > If the tag and `package.json` disagree the workflow fails immediately, before building — this is
   > what keeps the update feed from advertising the wrong version.

4. **Check** the `Release / validate`, `Release / windows`, `Release / macos`, and `Release / publish`
   runs under **Actions**, then confirm the release page has all nine assets attached — three from
   Windows (`astera-<version>-setup.exe`, its `.blockmap`, `latest.yml`), five from macOS
   (`astera-<version>-universal.dmg` and `Astera-<version>-universal-mac.zip`, a `.blockmap` for
   each, and `latest-mac.yml`), plus `policy.json`. Anything else on the page does not belong there.
   An older app picks the update up on its next check.

### How the workflow publishes

The release is created as a **draft**, and only becomes visible once every asset is attached. This
ordering is deliberate: `latest.yml` *is* the update feed, so a half-finished release would advertise
a version whose installer is not there yet.

The notes are written by `scripts/build-release-notes.cjs` from the commits since the previous tag,
grouped by conventional-commit type: `feat:` and `fix:` get a section each, everything else goes into
a collapsed one so nothing is silently dropped. **Commit subjects are therefore user-facing** — they
are the release page. gh's own `--generate-notes` is not used because it builds its list out of pull
requests, and this repository commits straight to the branch; that is why every release through
v1.0.3 shipped with nothing but a Full Changelog link.

Until macOS builds are notarized, a further step prepends the Gatekeeper caveat (the `xattr -cr`
line) to those notes. It drops out on its own once the Apple secrets are configured.

## Update campaigns (policy.json)

Used to notify users on particular versions (the default) or, when it is genuinely necessary, to stop
them from running the app at all.

```json
{ "id": "upgrade-1.0.0", "minVersion": "1.0.0", "maxVersion": "1.0.0", "mode": "notify" }
```

| Field | Meaning |
|---|---|
| `id` | Campaign identifier. When a user dismisses the notice, this id is remembered and it does not come back. `null` means no campaign (the default) |
| `minVersion` / `maxVersion` | **The target version range, bounds inclusive.** Not a blocking floor — only apps inside the range are targeted. To single out one defective build, set both to the same value |
| `mode` | `notify` (default, dismissible) or `block` (a blocking screen over the app) |

- The workflow attaches `policy.json` to every release, and the app reads it from
  `releases/latest/download/policy.json` — which always resolves to the newest release. **To change
  only the policy, edit that file and cut a new release**; the value stays in git, so it gets history
  and review.
- The workflow validates it: no range at all fails (that would target everyone), an inverted range
  fails, and **`block` requires a `maxVersion` that is lower than the release version**. Otherwise
  users on the newest build would be locked out with no update to take. `notify` only warns in the
  same situation.
- The app looks the policy up **once, at startup**. Changing the value does not affect apps that are
  already running.
- Every lookup failure — offline, 404, malformed, a typo in `mode` — falls back to no campaign (or to
  `notify`). A problem with the policy file must never lock a user out.

### Update check and download behaviour (for reference)

- **Checking:** once at startup, then every **24 hours**. On failure it backs off 1h → 2h → 4h → 6h
  (capped), and failures of automatic checks are not surfaced to the user. Only a check the user
  started themselves reports an error.
- **Downloading:** automatic (`autoDownload = true`). A version found by a check starts downloading
  right away, and the user presses `Install now` once it has arrived. A `Download` button is still
  there — in the settings row, the campaign toast and the block gate — for the window before the
  automatic download starts and for one that failed.

### Emergency — changing the policy without a new release

Not the recommended path, since app behaviour then changes outside git history. If you have to:

```bash
gh release upload vX.Y.Z policy.json --clobber
```

Commit the same value to `policy.json` in the repo afterwards, or the next release will revert it.

## Re-releasing and rolling back

- **Never reuse a version.** If a release was wrong, bump `version` again and cut a new tag.
- Deleting a tag (local and remote):
  ```bash
  git tag -d v1.0.1
  git push origin :refs/tags/v1.0.1
  ```
  The GitHub Release is **not** removed with the tag — delete it separately:
  ```bash
  gh release delete v1.0.1
  ```

## Windows code signing (SignPath)

The workflow has a built-in signing path modelled on how [Orca](https://github.com/stablyai/orca)
signs its Windows releases: artifacts are submitted to [SignPath.io](https://signpath.io), with the
certificate provided by the SignPath Foundation's free open-source program.

**It is fail-open.** With no SignPath configuration present, the signing steps are skipped and the
release ships unsigned — a fork or a fresh clone builds exactly as before. Once the configuration IS
present, it turns fail-closed: any signing failure fails the release rather than shipping a
half-signed build.

### How it signs

1. The app is built first, and every `.exe`/`.dll`/`.node` in the unpacked directory that does not
   already carry a valid Authenticode signature is zipped and submitted as one signing request.
   Files already signed by their vendor (Microsoft's conpty binaries, for instance) are left alone.
2. The NSIS installer is then assembled **from the signed files** (`--prepackaged`), and submitted as
   a second signing request.
3. Signing changes the installer's bytes, so `scripts/patch-update-feed.cjs` regenerates the
   `.blockmap` and rewrites the sha512/size in `latest.yml` — otherwise electron-updater would
   download the signed installer and reject it against the stale hash.

Step 1 also produces an installer that step 2 throws away, and that waste is deliberate — **do not
add `--dir` to skip it.** electron-builder writes `resources/app-update.yml` from `onAfterPack`, and
only when the build carries an nsis target; a `--dir` build's target is `dir`, and `--prepackaged`
skips packing entirely, so with `--dir` in place neither step ever wrote the file. `electron-updater`
reads it to learn which repository to check, so without it every update check fails with `ENOENT` —
which is exactly what shipped in the Windows builds of v1.0.0 through v1.1.0.

Signing policies usually require a **manual approval per request**: the workflow waits (up to an hour
per request) while you approve it in the SignPath dashboard.

### Enabling it

Apply at [signpath.org](https://signpath.org/apply) — the Foundation requires the project to already
be released, so this happens *after* the first public release. Note that the certificate names
**SignPath Foundation** as the publisher, not the repository owner. Once approved:

1. In SignPath, create a project with two artifact configurations — `windows-binaries-zip` (a zip
   container, deep-signing the PE files inside) and `windows-installer` (a single PE file) — and a
   `release-signing` policy. Connect the GitHub repository as the trusted build system.
2. In the GitHub repository settings, add:
   | Kind | Name | Value |
   |---|---|---|
   | Secret | `SIGNPATH_API_TOKEN` | API token from SignPath |
   | Variable | `SIGNPATH_ORGANIZATION_ID` | from the SignPath organization page |
   | Variable | `SIGNPATH_PROJECT_SLUG` | the SignPath project slug |
   | Variable | `SIGNPATH_POLICY_SLUG` | optional — defaults to `release-signing` |
3. Cut a release as usual. The signing steps engage on their own once the secret and the
   organization id are both present.

Known limitation: the uninstaller embedded inside the NSIS installer is generated during packaging
and stays unsigned — signing it would require a certificate on the build machine itself.

## macOS releases

### Code signing and notarization (Apple Developer ID)

Same fail-open shape as the Windows SignPath step — with no secrets present, the build ships without
a Developer ID; once you add them, the workflow turns fail-closed and a signing or notarization
failure fails the release rather than shipping a half-signed build.

**Where it differs from Windows, and why it matters more here:** on macOS, signing is not optional
the way it is on Windows. `electron-updater`'s macOS update path (Squirrel.Mac) refuses to install an
unsigned update onto a running app, so **shipping without a Developer ID means no auto-update at
all** — only a manual dmg download works. Windows SmartScreen is just a first-run speed bump by
comparison.

**The fail-open path is ad-hoc signed, not unsigned.** Apple Silicon refuses to execute arm64 code
carrying no signature at all — a kernel check with no Gatekeeper-style override — so a package with
no signature would fail to open on every arm64 Mac rather than merely warn on first launch. The
workflow passes `-c.mac.identity=-` on that path to get an ad-hoc signature, and verifies it
survived the build. Note that electron-builder signs ad-hoc *only* when the identity is explicitly
`-`; leaving it unset makes it skip signing altogether with nothing but a warning in the log.

Ad-hoc buys a launchable package, not a releasable one. Gatekeeper still blocks the first launch
(**System Settings → Privacy & Security → Open Anyway**; the Control-click → **Open** shortcut was
removed in macOS 15 Sequoia), the signature cannot be notarized, and auto-update stays off. Ship
that path as a pre-release, not as `--latest`.

Required secrets:

| Name | Value |
|---|---|
| `APPLE_CSC_LINK` | base64 of the Developer ID Application `.p12` (`base64 -i cert.p12`) |
| `APPLE_CSC_KEY_PASSWORD` | the password for that `.p12` |
| `APPLE_ID` | the Apple account email used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | an app-specific password for that account (not the account's own password) |
| `APPLE_TEAM_ID` | the Developer Team ID (10-character alphanumeric) |

The certificate must be a **Developer ID Application** type. `Apple Development` and `Mac App
Distribution` certificates cannot sign builds distributed outside the App Store.

Notarization is a round trip to Apple's servers and takes 5-20 minutes — it is normal for the
`macos` job to run long while it waits.

To verify a build locally:

```bash
spctl -a -vvv -t install dist-installer/mac-universal/Astera.app
```

Expect `accepted` and `source=Notarized Developer ID` in the output.

### Verifying the first macOS release

The first time you push a tag after this workflow change, check the following in order.

1. Bump `version` in `package.json`, commit, then `git tag vX.Y.Z && git push origin main --tags`
2. In Actions, confirm all four jobs (`validate`, `windows`, `macos`, `publish`) go green. It's normal
   for `macos` to take 5-20 minutes waiting on notarization.
3. On the release page, confirm all 7 assets are attached —
   `astera-X.Y.Z-setup.exe`, its `.blockmap`, `latest.yml`,
   `astera-X.Y.Z-universal.dmg`, `Astera-X.Y.Z-universal-mac.zip`, `latest-mac.yml`, `policy.json`.
4. **Actually verify auto-update.** With the previous version installed and running on macOS, launch
   it and an update notice should appear; accepting and restarting should land on the new version. If
   this step fails, the cause is almost always signing — Squirrel.Mac refuses unsigned updates.

### A locally built dmg cannot tell you whether Gatekeeper is happy

macOS only runs its first-launch check on files carrying `com.apple.quarantine`, and that attribute is
put there by whatever downloaded the file. A dmg you built yourself has never been downloaded, so it
does not have it — the app installed from it opens straight away no matter how it is signed. **"It
launched on my machine" therefore proves nothing about what a user will see.**

Check the signature itself instead, which is independent of quarantine:

```bash
spctl -a -vvv -t exec /Applications/Astera.app
```

An ad-hoc build (the unsigned release path) is *expected* to report `rejected` here; a notarized one
reports `accepted` with `source=Notarized Developer ID`.

To rehearse the actual first-launch experience, put the attribute on by hand:

```bash
xattr -w com.apple.quarantine "0083;00000000;Safari;" /Applications/Astera.app
open /Applications/Astera.app
```

Note that `xattr -cr`, the workaround the README gives users, strips every extended attribute — it was
measured not to disturb the ad-hoc code signature, and the app still launches and verifies afterwards.

## Notes

- Until SignPath is enabled, the installer is unsigned and Windows SmartScreen warns on first run
  (`More info` → `Run anyway`). Auto-update integrity does not depend on signing — it is verified
  against the sha512 in `latest.yml`.
- `build/icon.ico` and `build/icon.icns` are committed rather than generated in CI, because
  `scripts/gen-icon.ps1` uses System.Drawing and only runs on Windows, and `scripts/gen-icon-mac.sh`
  uses `sips`/`iconutil` and only runs on macOS. Since neither script can run on the other platform,
  and CI never runs both, both scripts' output has to be committed by whoever regenerates it.
