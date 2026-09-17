import type { SessionInfo, SessionKind } from '../types'

export const sessionKindOf = (info: Pick<SessionInfo, 'kind'>): SessionKind => info.kind ?? 'terminal'
