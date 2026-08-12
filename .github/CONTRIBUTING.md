# Contributing

Issues and pull requests are welcome. A couple of things worth knowing before you start:

- Run `npm run typecheck` and `npm run build` before opening a PR — that is what CI checks, in that
  order, after `npm ci`.
- `npm run typecheck` covers two TypeScript projects, and the split matters. `tsconfig.web.json` lists
  the node-free `src/core` files the renderer may import, one by one. Adding a core module and
  importing it from the renderer means adding it to that `include` array and keeping it free of `node:`
  imports — the renderer cannot load them. Anything needing `node:fs` or `node:child_process` belongs
  on the main side, with the shared types declared in `src/core/types.ts`.
- `docs/` is a whitelist: `docs/*` is ignored except for the pages explicitly un-ignored in
  `.gitignore`. A new file there defaults to "not published" and will not be committed, so
  documentation that ships has to extend one of the existing pages.
- The test sources are not in this repository, so a PR cannot add or change tests. If your change
  needs one, describe the case in the PR and it will be covered on the maintainer's side.
- The UI ships in Korean, English, Japanese, and Spanish, declared in one table in
  `src/core/i18n/index.ts`. Korean and English are maintained by the author; Japanese and Spanish
  were produced without a native speaker's review, so corrections there are welcome. To fix a
  translation, edit the matching catalog in `src/core/i18n/messages/<lang>.ts` — `ko.ts` is the
  source catalog and defines the key set, `en.ts` is complete. A key missing from `ja.ts` or `es.ts`
  falls back to English and then Korean, on purpose, so a partial translation PR is fine; you do not
  need to translate every string to contribute one. Two things any change must keep, checked by the
  invariant tests: a placeholder (`{name}`-style) identical to the Korean value, and product and
  command names — `Claude`, `Codex`, `Astera`, `Slack`, `GitHub`, `git`, `npm`, `PATH` — left
  untranslated.
- Bug reports are much easier to act on with the app version, your OS version, and the relevant
  lines from `rolling.log` when the problem involves account rolling — `%APPDATA%\astera\rolling.log`
  on Windows, `~/Library/Application Support/astera/rolling.log` on macOS.
- Commit subjects carry a type prefix. The ones in use are `feat:`, `fix:`, `docs:`, `ci:` and
  `chore:` — written as an instruction, with the body saying why rather than restating the diff. The
  release notes are generated from these subjects, so they end up in front of users.
- Open pull requests against `develop`. `main` is the release branch: a release is cut by tagging it
  `vX.Y.Z`, which is what publishes the installers and the update feed
  ([docs/releasing.md](../docs/releasing.md)).

See [Build from source](../README.md#build-from-source) in the README for the Node version, the native
toolchain `node-pty` needs, and the packaging scripts.
