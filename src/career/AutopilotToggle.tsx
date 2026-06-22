// Global Autopilot ON/OFF toggle — lives in the Career header so the daemon's
// state is visible + controllable from every page. The soul control of an
// "autopilot" product (UI-LAYOUT §2).
//
// 11-autopilot-ui-reframe m1. Consumes 10-autopilot-engine's
//   GET  /api/career/autopilot/status
//   POST /api/career/autopilot/enable | /disable
//
// Optimistic toggle: flip the pill immediately, roll back if the POST fails.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Power, Loader2 } from 'lucide-react'
import './autopilot-toggle.css'

type AutopilotStatus = {
  enabled: boolean
  last_tick_at: string | null
  daily_count: number
  daily_cap: number
  remaining_today: number
  engine_disabled?: boolean
}

const REFRESH_MS = 30_000

function relTime(iso: string | null): string {
  if (!iso) return 'never'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'never'
  const diff = Date.now() - t
  const m = 60_000
  const h = 60 * m
  if (diff < m) return 'just now'
  if (diff < h) return `${Math.floor(diff / m)}m ago`
  if (diff < 24 * h) return `${Math.floor(diff / h)}h ago`
  return `${Math.floor(diff / (24 * h))}d ago`
}

export default function AutopilotToggle() {
  const [status, setStatus] = useState<AutopilotStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  // Guard against setState after unmount (toggle's post-fetch has no signal).
  const mounted = useRef(true)

  const fetchStatus = useCallback(async (signal?: AbortSignal) => {
    try {
      const r = await fetch('/api/career/autopilot/status', { signal })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = (await r.json()) as AutopilotStatus
      if (!mounted.current) return
      setStatus(data)
      setError(false)
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError' || !mounted.current) return
      setError(true)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    const ctrl = new AbortController()
    fetchStatus(ctrl.signal)
    const t = setInterval(() => fetchStatus(ctrl.signal), REFRESH_MS)
    return () => {
      mounted.current = false
      ctrl.abort()
      clearInterval(t)
    }
  }, [fetchStatus])

  async function toggle() {
    if (!status || busy) return
    const next = !status.enabled
    setBusy(true)
    setStatus((s) => (s ? { ...s, enabled: next } : s)) // optimistic
    try {
      const r = await fetch(`/api/career/autopilot/${next ? 'enable' : 'disable'}`, { method: 'POST' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      // Re-sync from the server (enable kicks a tick that may move counters).
      await fetchStatus()
    } catch {
      // Roll back ONLY enabled on the latest snapshot (the poller may have
      // refreshed counters since the click).
      if (mounted.current) setStatus((s) => (s ? { ...s, enabled: !next } : s))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  if (!status) {
    return (
      <div className="apt-wrap apt-loading" aria-busy="true">
        <Loader2 size={14} className="apt-spin" />
        <span>Autopilot</span>
      </div>
    )
  }

  const on = status.enabled
  const engineOff = status.engine_disabled
  return (
    <button
      type="button"
      className={`apt-wrap${on ? ' apt-on' : ' apt-off'}${error ? ' apt-err' : ''}`}
      onClick={toggle}
      disabled={busy || engineOff}
      title={
        engineOff
          ? 'Engine disabled via DISABLE_AUTOPILOT_ENGINE — set the env var to 0 to control it here'
          : on
            ? 'Autopilot is ON — click to pause'
            : 'Autopilot is OFF — click to start auto-applying'
      }
      aria-pressed={on}
    >
      {busy ? <Loader2 size={14} className="apt-spin" /> : <Power size={14} />}
      <span className="apt-label">Autopilot</span>
      <span className="apt-state">{on ? 'ON' : 'OFF'}</span>
      <span className="apt-meta">
        {status.daily_count}/{status.daily_cap} today · {relTime(status.last_tick_at)}
      </span>
    </button>
  )
}
