/** Short and detail text for a context name: EKS ARN -> cluster + region, GKE -> cluster + zone. */
export function displayContextName(name: string): { short: string; detail: string | null } {
  const eks = /^arn:aws:eks:([^:]+):[^:]*:cluster\/(.+)$/.exec(name)
  if (eks) return { short: eks[2], detail: eks[1] }
  const gke = /^gke_[^_]+_([^_]+)_(.+)$/.exec(name)
  if (gke) return { short: gke[2], detail: gke[1] }
  return { short: name, detail: null }
}
