/**
 * Server-startup hook. Keep this file free of Node built-ins so the Edge
 * Runtime analyzer stays quiet. All Node work lives in instrumentation.node.ts
 * and is loaded only when NEXT_RUNTIME is nodejs.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (process.env.NEXT_PHASE === 'phase-production-build') return

  const { startNodeInstrumentation } = await import('./instrumentation.node')
  await startNodeInstrumentation()
}
