export interface ShutdownLayers {
  stopUi: () => Promise<void>
  stopDaemon: () => Promise<void>
  stopTuwunel: () => Promise<void>
  stopWebWatch?: () => Promise<void>
  /** Flush per-agent ACP taps before stopping the daemon. */
  stopCaptures?: () => Promise<void>
  /** Resolves once Tuwunel's captured stdio file is flushed. */
  finalizeTuwunelCapture?: () => Promise<void>
}

export function buildShutdown(layers: ShutdownLayers): () => Promise<void> {
  let started: Promise<void> | null = null
  return () => {
    if (started) return started
    started = (async () => {
      const order = [
        'stopUi',
        'stopWebWatch',
        'stopCaptures',
        'stopDaemon',
        'stopTuwunel',
        'finalizeTuwunelCapture',
      ] as const
      for (const step of order) {
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
