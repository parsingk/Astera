/** A kube tab closes without asking unless its edit holds text that was never applied (`dirty`: the tab ids the tabs
 *  reported through `KubeTabHost.setDirty`). */
export const kubeTabCloseNeedsAsk = (dirty: ReadonlySet<string>, tabId: string): boolean => dirty.has(tabId)
