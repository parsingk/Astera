// The Host proves who it is before a client hands it anything (security review 2026-09-28, the Windows pipe
// squat): an HMAC of each client's nonce under a key in the profile folder. The key and the proof are the SDK
// package's (packages/client/src/hostKey.ts), so the Host that answers and every client that checks share one copy.
// The app proves it is the app the same way, under a key of its own (`app.key`) that sandboxed sessions are denied.
export {
  appKeyPath,
  appProof,
  appProofMatches,
  ensureAppKey,
  ensureHostKey,
  hostKeyPath,
  hostProof,
  newHostNonce,
  proofMatches,
  readAppKey,
  readAppKeySync,
  readHostKey
} from '../publicContract'
