// Autopilot Dashboard — the landing page (UI-LAYOUT §3.1). The main stage of an
// autopilot product is the MACHINE'S STATE, not a job list:
//   - status card: big ON/OFF + run summary + Tune link
//   - 4 funnel cards: candidates → filling → parked(awaiting submit) → submitted
//   - activity stream: the daemon's recent per-candidate outcomes
//
// 11-autopilot-ui-reframe m1. Consumes 10-autopilot-engine's
//   GET /api/career/autopilot/status
//   GET /api/career/autopilot/feed
//
// NOTE: the "parked / 去处理" targets point at /career/applied for now — the
// dedicated Review queue lands in m2, then m4 repoints these to /career/review.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Power, Search, Loader2, PenLine, Inbox, Send, Activity,
  CheckCircle2, AlertTriangle, Clock, SlidersHorizontal, RefreshCw,
} from 'lucide-react'
import './dashboard.css'

const REFRESH_MS = 30_000

type Status = {
  enabled: boolean
  last_tick_at: string | null
  daily_count: number
  daily_cap: number
  score_threshold: number
  remaining_today: number
  engine_disabled?: boolean
}

type Funnel = { candidates: number; filling: number; parked: number; submitted: number }
type FeedEvent = {
  ts: string
  type: 'parked' | 'needs_review' | 'needs_human' | 'failed' | 'timeout' | 'busy'
  jobId?: string
  company?: string
  role?: string
  ats?: string
  escalationCode?: string | null
}
type FeedResp = { events: FeedEvent[]; funnel: Funnel }

function relTime(iso: string | null): string {
  if (!iso) return 'never'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return String(iso)
  const diff = Date.now() - t
  const m = 60_000, h = 60 * m, d = 24 * h
  if (diff < m) return 'just now'
  if (diff < h) return `${Math.floor(diff / m)}m ago`
  if (diff < d) return `${Math.floor(diff / h)}h ago`
  return `${Math.floor(diff / d)}d ago`
}

// Per-event-type presentation: icon + label + tone.
const EVENT_META: Record<FeedEvent['type'], { label: string; tone: string; Icon: typeof Power }> = {
  parked:       { label: 'Filled — awaiting your Submit', tone: 'ok',    Icon: CheckCircle2 },
  needs_review: { label: 'Needs your answer',             tone: 'warn',  Icon: AlertTriangle },
  needs_human:  { label: 'Needs manual takeover',         tone: 'bad',   Icon: AlertTriangle },
  failed:       { label: 'Fill failed',                   tone: 'bad',   Icon: AlertTriangle },
  timeout:      { label: 'Timed out',                     tone: 'muted', Icon: Clock },
  busy:         { label: 'Already in progress',           tone: 'muted', Icon: Clock },
}

export default function Dashboard() {
  const [status, setStatus] = useState<Status | null>(null)
  const [feed, setFeed] = useState<FeedResp | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)

  const fetchAll = useCallback(async (signal?: AbortSignal) => {
    try {
      const [st, fd] = await Promise.all([
        fetch('/api/career/autopilot/status', { signal }).then((r) => { if (!r.ok) throw new Error(`status HTTP ${r.status}`); return r.json() }),
        fetch('/api/career/autopilot/feed?limit=20', { signal }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ])
      if (!mounted.current) return
      setStatus(st as Status)
      if (fd) setFeed(fd as FeedResp)
      setError(null)
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError' || !mounted.current) return
      setError((e as Error).message ?? 'Failed to load')
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    const ctrl = new AbortController()
    fetchAll(ctrl.signal)
    const t = setInterval(() => fetchAll(ctrl.signal), REFRESH_MS)
    return () => { mounted.current = false; ctrl.abort(); clearInterval(t) }
  }, [fetchAll])

  async function toggle() {
    if (!status || busy) return
    const next = !status.enabled
    setBusy(true)
    setStatus((s) => (s ? { ...s, enabled: next } : s))
    try {
      const r = await fetch(`/api/career/autopilot/${next ? 'enable' : 'disable'}`, { method: 'POST' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      await fetchAll()
    } catch {
      if (mounted.current) setStatus((s) => (s ? { ...s, enabled: !next } : s))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  if (loading && !status) {
    return <div className="c-page db-page"><p className="db-muted"><Loader2 size={14} className="db-spin" /> Loading…</p></div>
  }

  const on = !!status?.enabled
  const funnel = feed?.funnel ?? { candidates: 0, filling: 0, parked: 0, submitted: 0 }

  return (
    <div className="c-page db-page">
      <h2>Autopilot 控制台</h2>

      {error && <p className="db-error"><AlertTriangle size={14} /> {error}</p>}

      {/* status card */}
      <section className={`db-status ${on ? 'db-status-on' : 'db-status-off'}`}>
        <div className="db-status-main">
          <span className={`db-led ${on ? 'db-led-on' : ''}`} />
          <div>
            <div className="db-status-title">
              Autopilot <strong>{on ? 'ON' : 'OFF'}</strong>
            </div>
            <div className="db-status-sub">
              {status?.engine_disabled
                ? 'Engine disabled (DISABLE_AUTOPILOT_ENGINE=1)'
                : on
                  ? `Running · ${status?.daily_count}/${status?.daily_cap} filled today · last tick ${relTime(status?.last_tick_at ?? null)}`
                  : `Paused · ${status?.remaining_today ?? 0} slots left today`}
            </div>
          </div>
        </div>
        <div className="db-status-actions">
          <button type="button" className={`db-btn ${on ? 'db-btn-warn' : 'db-btn-primary'}`} onClick={toggle} disabled={busy || status?.engine_disabled}>
            {busy ? <Loader2 size={14} className="db-spin" /> : <Power size={14} />}
            {on ? 'Pause' : 'Start'}
          </button>
          <Link to="/career/settings/preferences" className="db-btn db-btn-ghost"><SlidersHorizontal size={14} /> Tune</Link>
          <button type="button" className="db-btn db-btn-ghost" onClick={() => fetchAll()}><RefreshCw size={14} /> Refresh</button>
        </div>
      </section>

      {/* funnel: candidates → filling → parked → submitted */}
      <section className="db-funnel">
        <FunnelCard n={funnel.candidates} label="候选" hint="符合条件待投" Icon={Search} to="/career/find-jobs" />
        <span className="db-funnel-arrow">→</span>
        <FunnelCard n={funnel.filling} label="填表中" hint="机器正在填" Icon={PenLine} />
        <span className="db-funnel-arrow">→</span>
        <FunnelCard n={funnel.parked} label="待批准" hint="填好等你 Submit" Icon={Inbox} to="/career/applied" highlight />
        <span className="db-funnel-arrow">→</span>
        <FunnelCard n={funnel.submitted} label="已提交" hint="已投出" Icon={Send} to="/career/applied" />
      </section>

      {/* activity stream */}
      <section className="db-activity">
        <h3 className="db-activity-head"><Activity size={15} /> 实时活动流</h3>
        {!feed || feed.events.length === 0 ? (
          <p className="db-muted">还没有活动。{on ? '机器在跑,稍候会出现。' : '打开 Autopilot 让机器开始投递。'}</p>
        ) : (
          <ul className="db-feed">
            {feed.events.map((e, i) => {
              const meta = EVENT_META[e.type] ?? EVENT_META.failed
              const Icon = meta.Icon
              const actionable = e.type === 'parked' || e.type === 'needs_review' || e.type === 'needs_human'
              return (
                <li key={`${e.ts}-${e.jobId ?? i}`} className={`db-feed-row db-tone-${meta.tone}`}>
                  <Icon size={14} className="db-feed-icon" />
                  <span className="db-feed-time">{relTime(e.ts)}</span>
                  <span className="db-feed-co">{e.company || e.jobId || '—'}{e.role ? ` · ${e.role}` : ''}</span>
                  <span className="db-feed-label">{meta.label}</span>
                  {actionable && <Link to="/career/applied" className="db-feed-action">去处理 →</Link>}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

function FunnelCard({
  n, label, hint, Icon, to, highlight,
}: {
  n: number; label: string; hint: string; Icon: typeof Power; to?: string; highlight?: boolean
}) {
  const inner = (
    <>
      <Icon size={16} className="db-card-icon" />
      <div className="db-card-n">{n}</div>
      <div className="db-card-label">{label}</div>
      <div className="db-card-hint">{hint}</div>
    </>
  )
  const cls = `db-card${highlight ? ' db-card-hi' : ''}${to ? ' db-card-link' : ''}`
  return to ? <Link to={to} className={cls}>{inner}</Link> : <div className={cls}>{inner}</div>
}
