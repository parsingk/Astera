// The Enforce hook bundled into one CommonJS file at build time (electron.vite.enforceHook.ts), as text the session
// files are written from.
declare module 'virtual:astera-enforce-hook' {
  const source: string
  export default source
}
