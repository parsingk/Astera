// Enforce's hook as one file (enforce design §5): the main build (and vitest) serve `virtual:astera-enforce-hook`, the
// text of src/core/audit/hook/enforceMain.ts bundled with what it imports into one CommonJS file. The app and the Host
// write that text into the profile beside the Rules, the way the capture scripts are written, so a CLI's hook runs it with
// Astera's own node and no chunk of the app beside it. Bundled with vite's own build (a direct dependency), once per
// process.
import { fileURLToPath } from 'node:url'
import { build, type Plugin } from 'vite'

const ID = 'virtual:astera-enforce-hook'
const RESOLVED = `\0${ID}`
const ENTRY = fileURLToPath(new URL('./src/core/audit/hook/enforceMain.ts', import.meta.url))

let built: Promise<string> | null = null

/** The bundled hook's text. */
export function buildEnforceHook(): Promise<string> {
  built ??= (async () => {
    const out = await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        ssr: ENTRY,
        target: 'node18',
        minify: false,
        emptyOutDir: false,
        rollupOptions: { output: { format: 'cjs', entryFileNames: 'astera-enforce-hook.cjs', inlineDynamicImports: true } }
      },
      ssr: { noExternal: true }
    })
    const outputs = Array.isArray(out) ? out : [out]
    for (const o of outputs) {
      if (!('output' in o)) continue
      const chunk = o.output.find((c) => c.type === 'chunk' && c.isEntry)
      if (chunk && chunk.type === 'chunk') return chunk.code
    }
    throw new Error('the enforce hook bundle has no entry chunk')
  })()
  return built
}

export function enforceHookPlugin(): Plugin {
  return {
    name: 'astera-enforce-hook',
    resolveId: (id) => (id === ID ? RESOLVED : null),
    load: async (id) => (id === RESOLVED ? `export default ${JSON.stringify(await buildEnforceHook())}` : null)
  }
}
