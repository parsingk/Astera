// The plugins `astera plugins init` writes (Plugin Platform V2, Phase 2 step 4a, spec E4): one restricted UI plugin and
// three trusted ones, a Host plugin, a completion check and a job source. Each is the smallest plugin of its kind that
// installs and runs, in plain JavaScript with no dependency, so its folder installs as it is; the plugin SDK's types are
// named in JSDoc for an editor and tsc only, as the samples in examples/plugins do. cli/pluginTemplates.test.ts checks
// each passes the folder check an install makes.

export const PLUGIN_TEMPLATES = ['ui', 'host', 'check', 'source'] as const
export type PluginTemplate = (typeof PLUGIN_TEMPLATES)[number]

/** The name people see: the npm name's last part, its dashes as spaces, its first letter capital. */
export function displayNameOf(name: string): string {
  const last = name.split('/').pop() ?? name
  const words = last.replace(/[-_.]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const lines = (...l: string[]): string => l.join('\n') + '\n'
const json = (v: unknown): string => JSON.stringify(v, null, 2) + '\n'

const readme = (display: string, about: string, use: string[]): string =>
  lines(
    `# ${display}`,
    '',
    about,
    '',
    '## Try it',
    '',
    'Check the folder as an install would, then install it from a terminal of your own with the Astera app running:',
    '',
    '```sh',
    'astera plugins validate --path .',
    'astera plugins install --path . --yes',
    '```',
    '',
    ...use,
    '',
    'The plugin guide (docs/plugins.md in the Astera repository) says what each field of package.json means and what the',
    'plugin may do.'
  )

function ui(name: string, display: string): Record<string, string> {
  return {
    'package.json': json({
      name,
      version: '0.1.0',
      displayName: display,
      description: `${display}: a panel in Astera.`,
      astera: {
        apiVersion: '2',
        ui: 'ui/index.html',
        permissions: ['commands.register', 'panels.register', 'workspace.read'],
        contributes: { panels: [{ id: 'main', title: display }], commands: [{ id: 'open', title: `Open ${display}`, panel: 'main' }] }
      }
    }),
    'ui/index.html': lines(
      '<!doctype html>',
      '<html lang="en">',
      '  <head>',
      '    <meta charset="utf-8" />',
      `    <title>${display}</title>`,
      '    <link rel="stylesheet" href="panel.css" />',
      '    <script src="panel.js" defer></script>',
      '  </head>',
      '  <body>',
      `    <h1>${display}</h1>`,
      '    <p id="project">…</p>',
      '  </body>',
      '</html>'
    ),
    'ui/panel.js': lines(
      "// The panel's page. It runs in a sandboxed panel of its own: no Node, no network, no inline script, and one bridge,",
      '// window.astera, whose context() says which plugin and panel this is and, with workspace.read, which project is open.',
      'window.astera.context().then(',
      '  (ctx) => {',
      "    document.getElementById('project').textContent = ctx.project ? `Project: ${ctx.project.name}` : 'No project was open'",
      '  },',
      "  (err) => (document.getElementById('project').textContent = `Astera did not answer: ${err.message}`)",
      ')'
    ),
    'ui/panel.css': lines(
      "/* Every Astera theme is dark: a page that follows the system's light mode stands white beside the app */",
      ':root {',
      '  color-scheme: dark;',
      '  font: 13px/1.5 system-ui, sans-serif;',
      '}',
      'body {',
      '  margin: 0;',
      '  padding: 24px;',
      '  background: Canvas;',
      '  color: CanvasText;',
      '}'
    ),
    'README.md': readme(display, 'A restricted UI plugin: one panel, opened from the command palette. It starts no program on your machine.', [
      `Then open the command palette (Ctrl+Shift+P, Cmd+Shift+P on macOS) and run **Open ${display}**.`
    ])
  }
}

function host(name: string, display: string): Record<string, string> {
  return {
    'package.json': json({
      name,
      version: '0.1.0',
      displayName: display,
      description: `${display}: a plugin Astera runs.`,
      type: 'module',
      astera: { apiVersion: '1', entry: 'index.mjs', permissions: ['projects.read'] }
    }),
    'index.mjs': lines(
      '// @ts-check',
      '// A plugin Astera runs as a program of its own, with your rights on this machine. It asks Astera only for what its',
      '// permissions name: here, the list of projects.',
      '',
      "/** @type {import('@astera-app/plugin-sdk').PluginDefinition} */",
      'export default {',
      '  async activate(ctx) {',
      "    // A call can be refused (the person may grant less than it asks): say so and keep running",
      '    try {',
      '      const { items } = await ctx.astera.projects.list()',
      '      ctx.log.info(`Astera has ${items.length} projects`)',
      '    } catch (err) {',
      '      ctx.log.warn(`could not list the projects: ${err instanceof Error ? err.message : String(err)}`)',
      '    }',
      '  }',
      '}'
    ),
    'README.md': readme(display, 'A plugin Astera runs: trusted code, which can do anything you can on this machine.', [
      `Then read its log: \`astera plugins logs --id ${name}\`.`
    ])
  }
}

function check(name: string, display: string): Record<string, string> {
  return {
    'package.json': json({
      name,
      version: '0.1.0',
      displayName: display,
      description: `${display}: a completion check for Tasks.`,
      type: 'module',
      astera: { apiVersion: '1', entry: 'index.mjs', capabilities: ['completion-check'], permissions: [] }
    }),
    'index.mjs': lines(
      '// @ts-check',
      "// A completion check: Astera asks it whether a Task's work is done, in the folder the Task's checks run in. It",
      '// only answers Astera, so it needs no permission. A plain object is the provider defineCompletionCheckProvider would',
      '// have returned.',
      '',
      "/** @type {import('@astera-app/plugin-sdk').CompletionCheckProvider} */",
      'export default {',
      '  async runCheck({ workspace }) {',
      '    // Look at what the Task changed under workspace.root, then pass or fail with what a worker should fix',
      "    return { status: 'passed', summary: `nothing to check yet in ${workspace.root}` }",
      '  }',
      '}'
    ),
    'README.md': readme(display, "A completion check: Astera asks it whether a Task's work is done.", [
      `Then name it among a Task's checks: \`--validate plugin:${name}\`.`
    ])
  }
}

function source(name: string, display: string): Record<string, string> {
  return {
    'package.json': json({
      name,
      version: '0.1.0',
      displayName: display,
      description: `${display}: a job source.`,
      type: 'module',
      astera: { apiVersion: '1', entry: 'index.mjs', capabilities: ['job-source'], permissions: [] }
    }),
    'index.mjs': lines(
      '// @ts-check',
      '// A job source: Astera lists its items, reads one whole, and makes a Job from it. It only answers Astera, so it',
      '// needs no permission. A plain object is the provider defineJobSourceProvider would have returned.',
      '',
      "const items = [{ id: 'ITEM-1', title: 'A first item', body: 'What the Job is for.' }]",
      '',
      '/** @param {string} id */',
      'const item = (id) => {',
      '  const found = items.find((i) => i.id === id)',
      '  if (!found) throw new Error(`there is no item ${id}`)',
      '  return found',
      '}',
      '',
      "/** @type {import('@astera-app/plugin-sdk').JobSourceProvider} */",
      'export default {',
      '  listItems({ query }) {',
      '    const found = items.filter((i) => query === undefined || i.title.includes(query))',
      '    return { items: found.map(({ id, title }) => ({ id, title })) }',
      '  },',
      '  getItem(id) {',
      '    const { title, body } = item(id)',
      '    return { id, title, body }',
      '  },',
      '  buildJobContext(id) {',
      '    const { title, body } = item(id)',
      `    return { objective: title, sourceLabel: \`${display} \${id}\`, evidence: [{ label: 'Description', content: body }] }`,
      '  }',
      '}'
    ),
    'README.md': readme(display, 'A job source: its items are listed in Astera, and a Job can be made from one.', [
      `Then list its items: \`astera sources items --source ${name}\`.`
    ])
  }
}

/** The files of the `kind` template for the npm name `name`, by their path in the plugin folder. */
export function pluginTemplate(kind: PluginTemplate, name: string): Record<string, string> {
  const display = displayNameOf(name)
  return kind === 'ui' ? ui(name, display) : kind === 'host' ? host(name, display) : kind === 'check' ? check(name, display) : source(name, display)
}
