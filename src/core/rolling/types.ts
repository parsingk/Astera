/** Persisted rolling config values. accountIds is the roll order; prompt is the continue-the-work phrase (the default is used when empty). */
export interface RollConfig {
  accountIds: string[]
  prompt?: string
}
