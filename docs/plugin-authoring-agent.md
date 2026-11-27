# Writing an Astera plugin: instructions for a coding agent

Copy this file into a plugin's repository as `AGENTS.md` (or `CLAUDE.md`) so an agent working there follows Astera's
plugin contract. The full guide is [docs/plugins.md](plugins.md); the catalog rules are
[docs/plugin-registry.md](plugin-registry.md).

## The contract

- The plugin is an npm package whose `package.json` holds an `astera` field. Plugin API 2 takes an `entry` (a Node
  file Astera starts, trusted code), a `ui` (a page shown in a sandboxed panel, restricted UI), themes only
  (declarative), or a mix. Choose the least: a page or themes need no program.
- Ask only for the permissions the plugin uses. `commands.register`, `panels.register`, `workspace.read` and
  `themes.register` are the UI's; the rest open Host commands for an `entry`.
- A page loads only its own files: no inline `<script>`, no `onclick`, no remote address, no network. Read where it is
  with `window.astera.context()`.
- A theme sets `#rrggbb` colours over a built-in base and must keep the contrast floors; surfaces stay dark.

## The loop

1. `astera plugins init <name> --template ui|host|check|source` to start, or edit the folder you have.
2. `astera plugins validate --path .` after every change: it names each problem by its code.
3. `astera plugins test --path .` to run it against a fake Host (or its page and themes checks).
4. `astera plugins dev --path . --yes` to install it and install again on each change (a person runs this: it is
   refused inside an agent session).
5. `astera plugins pack --path .` for a package, and `astera plugins publish --path . --artifact-url <url> --publisher
   <name>` for the registry entry. Publishing nothing: serving the package and opening the pull request are a person's.

## Never

- Never ask for a permission "just in case", never read or print a secret setting, never write outside the plugin's
  own data, and never weaken a check to make `validate` or `test` pass.
- Never install, enable or publish a plugin on the person's behalf from an agent session: those are refused there on
  purpose.
