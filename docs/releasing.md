# Releasing

Astera is released by **pushing a `vX.Y.Z` tag**. That triggers
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which builds the Windows
installer, publishes it to GitHub Releases, and installed apps then update themselves through
`electron-updater`.

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

4. **Check** the `Release / windows` run under **Actions**, then confirm the release page has
   `latest.yml`, `astera-<version>-setup.exe`, the `.blockmap`, and `policy.json` attached. An older
   app picks the update up on its next check.

### How the workflow publishes

The release is created as a **draft**, and only becomes visible once every asset is attached. This
ordering is deliberate: `latest.yml` *is* the update feed, so a half-finished release would advertise
a version whose installer is not there yet.

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
- **Downloading:** never automatic (`autoDownload = false`). The user presses `Download`, then
  `Install now` once it has arrived. The point is not to pull ~100 MB without consent.

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

1. The unpacked app is built first (`--dir`), and every `.exe`/`.dll`/`.node` in it that does not
   already carry a valid Authenticode signature is zipped and submitted as one signing request.
   Files already signed by their vendor (Microsoft's conpty binaries, for instance) are left alone.
2. The NSIS installer is then assembled **from the signed files** (`--prepackaged`), and submitted as
   a second signing request.
3. Signing changes the installer's bytes, so `scripts/patch-update-feed.cjs` regenerates the
   `.blockmap` and rewrites the sha512/size in `latest.yml` — otherwise electron-updater would
   download the signed installer and reject it against the stale hash.

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

## Notes

- Until SignPath is enabled, the installer is unsigned and Windows SmartScreen warns on first run
  (`More info` → `Run anyway`). Auto-update integrity does not depend on signing — it is verified
  against the sha512 in `latest.yml`.
- `build/icon.ico` is committed rather than generated in CI, because `scripts/gen-icon.ps1` uses
  System.Drawing and therefore only runs on Windows.
