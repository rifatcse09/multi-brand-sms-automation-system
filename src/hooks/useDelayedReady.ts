import { useEffect, useState } from 'react'

/** Simulates first paint / fetch delay for skeleton demos */
export function useDelayedReady(ms = 550) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(() => setReady(true), ms)
    return () => window.clearTimeout(t)
  }, [ms])
  return ready
}
