// The Remote Gateway's state as the Host reports it (remote runtime design §2.3): to `astera runtime status`, to
// `runtime-status`, and to local apps as `gateway-state`.
export type GatewayState =
  | { state: 'disabled' }
  | { state: 'starting'; listen: string; port: number }
  | { state: 'ready'; listen: string; port: number; fingerprint: string }
  | { state: 'failed'; code: string; message: string; listen?: string; port?: number }
