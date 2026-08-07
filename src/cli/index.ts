// astera — entry point of the orchestration CLI.
// It is an RPC client against the local server of the running app. It never touches state directly.
//
// It is the second entry point of the electron-vite main bundle (electron.vite.config.ts), so it
// builds to out/main/cli.js. The shuttle (shuttle.ts) runs that artifact with
// ELECTRON_RUN_AS_NODE=1 — at that moment the Electron APIs (app, BrowserWindow, and so on) do not
// exist, so nothing here may ever import them.
//
// The actual logic is in run.ts. This file is an entry point that executes immediately at the top
// level and so cannot be tested; the side-effect-free functions and main() were moved out to make
// them testable, and all that is left here is the call.
import { main } from './run'

main()
