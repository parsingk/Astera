# Code signing policy

This is the code signing policy for Astera, published to satisfy the
[SignPath Foundation conditions for Open Source projects](https://signpath.org/terms.html).

## Certificate

Windows releases of Astera are signed with a certificate provided free of charge by the
[SignPath Foundation](https://signpath.org), using the code signing service
[SignPath.io](https://signpath.io). The private key never leaves SignPath's HSM and is not held by
this project or its maintainer.

Because the certificate is issued to the Foundation rather than to this project, Windows shows
**SignPath Foundation** as the publisher in UAC and SmartScreen dialogs. That is expected and is not
a sign that the installer came from somewhere else.

macOS releases are signed and notarized separately with an Apple Developer ID; SignPath is not
involved there.

## Team roles

Astera is maintained by a single person, [parsingk](https://github.com/parsingk), who therefore holds
all three roles. Multi-factor authentication is enabled on both the GitHub and the SignPath account.
Should the project gain further maintainers, this section is updated before they are granted any of
these roles.

- **Authors** — may modify the source code without a separate review: parsingk.
- **Reviewers** — review every change proposed by anyone who is not an author, i.e. all external
  pull requests: parsingk.
- **Approvers** — decide whether a given release may be signed, and approve each signing request
  individually in the SignPath dashboard: parsingk.

## What gets signed, and how

Signing happens inside the tagged release workflow
([`.github/workflows/release.yml`](../.github/workflows/release.yml)) and nowhere else:

1. A `vX.Y.Z` tag is pushed and GitHub Actions builds the app from the tagged source.
2. The unsigned Windows binaries are collected and submitted to SignPath as one signing request,
   which an approver then approves by hand. Nothing is signed automatically.
3. The signed binaries are put back in place, the NSIS installer is assembled from them, and the
   installer itself is signed as a second request.
4. Only then are the assets attached to the GitHub release.

Nothing is signed from a developer machine, from a branch, or outside this workflow. Every signed
artifact is therefore reproducible from the tagged commit in this repository.

## Privacy

Astera collects no analytics and no telemetry. It contains no tracking, crash-reporting, or usage
measurement of any kind, and it sends nothing about you or your work to the maintainer.

The app makes network requests only where doing so is the feature you asked for:

- **Updates** — it checks the public GitHub Releases feed for this repository and asks before
  downloading anything.
- **The agent CLIs** — Astera runs the `claude` and `codex` CLIs installed on your own machine. Any
  traffic they generate goes to their vendors under their own terms, exactly as it would if you ran
  them in a terminal yourself.
- **Slack** — only if you configure a Slack bot token, and only to the workspace you point it at.

Credentials, session state, and logs stay on your machine under `%APPDATA%\astera` (Windows) or
`~/Library/Application Support/astera` (macOS).

## Uninstalling

On Windows, the installer registers an entry under **Settings → Apps → Installed apps**, or you can
run `Uninstall Astera.exe` from the install directory. On macOS, drag `Astera.app` out of
Applications. Neither removes the data directory above — delete it by hand if you want the settings
and logs gone too.
