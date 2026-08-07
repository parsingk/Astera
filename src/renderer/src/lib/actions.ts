// This renderer's action list. The platform never changes for the life of the process, so build it
// once and share it. The reason core/keys/binding.ts is a factory (pinning the platform for tests)
// still holds — this is just the one place the renderer calls that factory.
import { makeActions } from '../../../core/keys/binding'

export const ACTIONS = makeActions(window.api.platform)
