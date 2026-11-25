// The Hello panel's page. It runs in the panel's own sandboxed guest, not in Astera's window: no Node, no network, no
// inline script, and one bridge, window.astera, whose context() says which plugin and panel this page is and, with the
// workspace.read permission, which project the panel was opened in. Text goes in with textContent, never as HTML.
const show = (id, text) => {
  document.getElementById(id).textContent = text
}

window.astera.context().then(
  (ctx) => {
    show('plugin', ctx.plugin)
    show('panel', ctx.panel)
    show('project', ctx.project ? ctx.project.name : 'No project was open when this panel opened')
  },
  (err) => show('note', `Astera did not answer: ${err.message}`)
)
