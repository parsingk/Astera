# Hello panel

A UI-only Astera plugin (Plugin API 2): one panel that greets you and names the plugin, the panel and the project it
was opened in. It starts no program on your machine; its page runs in a sandboxed panel of its own, with no network,
and reaches Astera only through the permissions it asks for. [The plugin guide](../../../docs/plugins.md#plugin-api-2)
says what a panel's page may do.

## Install it

From a clone of the Astera repository, with the Astera app running:

```sh
astera plugins install --path examples/plugins/hello-panel
```

That shows what the plugin is: restricted UI, asking to add a command and a panel and to read which project is open.
Approve it with `--yes`, or in the app under Settings, Plugins, Install from a folder.

## Use it

Open the command palette (Ctrl+Shift+P, Cmd+Shift+P on macOS) and run **Open Hello panel**. The panel opens as a tab in
the workbench, beside your sessions and files; running the command again brings the same tab forward. The tab comes
back after a restart, loaded when you select it.

## Change it

`ui/index.html` is the page, `ui/panel.js` its script and `ui/panel.css` its style. A page may load only its own files:
an inline `<script>` or `onclick`, a remote script and any request to the network are refused. `window.astera.context()`
answers `{ plugin, panel, project }`, with `project` (`{ root, name }`) only while the plugin has `workspace.read` and a
project was open.

Reinstall the folder after a change, then close the panel's tab and run the command again to see the new page.
