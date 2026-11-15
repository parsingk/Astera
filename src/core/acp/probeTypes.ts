// The answer of the "Test this reviewer" probe (probe.ts), apart from it so the renderer's types may name it: probe.ts
// reaches node. `kind` is `'not-found'` or an AcpFailureKind (client.ts); the compiler checks probe.ts's use of it.
export type ReviewerProbe =
  | { ok: true; agent: { name?: string; title?: string; version?: string } }
  | { ok: false; kind: 'not-found' | 'unsupported-version' | 'sign-in' | 'timeout' | 'exited' | 'violation' | 'protocol'; message: string }
