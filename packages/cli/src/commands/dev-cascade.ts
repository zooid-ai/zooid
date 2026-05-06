export interface ShutdownLayers {
  stopUi: () => Promise<void>
  stopDaemon: () => Promise<void>
  stopTuwunel: () => Promise<void>
  stopWebWatch?: () => Promise<void>
}

export function buildShutdown(layers: ShutdownLayers): () => Promise<void> {
  let started: Promise<void> | null = null
  return () => {
    if (started) return started
    started = (async () => {
      for (const step of ['stopUi', 'stopWebWatch', 'stopDaemon', 'stopTuwunel'] as const) {
        try {
          await layers[step]?.()
        } catch (err) {
          console.error(`${step}:`, err)
        }
      }
    })()
    return started
  }
}
