// What the Astera app imports from the package beyond the published API (src/core/publicContract.ts is the one
// door): the public field lists and their shaping, and the Host transport the app, the CLI and the SDK share. Not
// in the package's exports map, so a consumer of the published package cannot depend on it.
export * from './index.js'
export * from './fields.js'
export { publicEvent, publicFor, shapeEvent } from './shape.js'
export * from './framing.js'
export * from './hostKey.js'
export * from './socketDir.js'
export * from './address.js'
export * from './discovery.js'
export * from './protocol.js'
export * from './connect.js'
export * from './loopback.js'
export * from './deadlines.js'
export * from './follow.js'
export { createAsteraClientOver } from './client.js'
