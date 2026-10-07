// Settings > Creative Hub: the outside creative platforms whose CLI accounts Astera keeps (Higgsfield
// first). Kept free of React so the rules below test without a renderer; CreativeHubSettings.tsx pairs
// each platform with its settings component.

export interface CreativePlatform {
  id: string
  /** A product name, shown as is in every language. */
  label: string
}

/** The picker over the platforms appears once there is more than one; with one, its section shows alone. */
export const showsPicker = (platforms: readonly CreativePlatform[]): boolean => platforms.length > 1

/** The platform to show: the chosen one, else the first (a choice remembered from a platform that is
 *  no longer listed falls back rather than showing nothing). */
export function pickPlatform<T extends CreativePlatform>(platforms: readonly T[], chosen: string | null): T | undefined {
  return platforms.find((p) => p.id === chosen) ?? platforms[0]
}
