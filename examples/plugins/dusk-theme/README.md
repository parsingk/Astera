# Dusk theme

A themes-only Astera plugin (Plugin API 2): one colour theme over Vega, with a blue accent and a deeper status bar. It
runs no code and shows no page; Astera applies its colours itself. [The plugin guide](../../../docs/plugins.md#themes)
says what a theme may set.

## Install it

From a clone of the Astera repository, with the Astera app running:

```sh
astera plugins install --path examples/plugins/dusk-theme
```

That shows what the plugin is: themes only, asking to add themes. Approve it with `--yes`, or in the app under
Settings, Plugins, Install from a folder.

## Use it

Open Settings, General, Theme. **Dusk** is under Plugin themes, named with this plugin. Turning the plugin off shows the
default theme and keeps your choice, so turning it on again brings Dusk back.

## Change it

`package.json` is the whole plugin. Each colour is `#rrggbb`, over the colours of its `base`; a palette that would make
text hard to read, or a surface brighter than Astera's own, is refused when the plugin is installed.
