// Review — the human-gate inbox (UI-LAYOUT §3.2). The page the user lives in:
// every application the autopilot filled and parked, waiting on a human action.
// Three buckets:
//   🟢 待提交  — filled to the submit gate; you review + Submit (in browser)
//   🔴 需接管  — login wall / stale / failed; you take over manually
//   ⚪ 填表中  — a fill is in progress (informational)
//
// The deep per-field actions (preview, submit, retry a field) live on the
// existing Apply page (/career/apply/:jobId); Review routes you there. The one
// action Review owns is the flywheel: bank an answer the machine couldn't fill
// so the next run auto-fills it (POST /api/career/qa-bank/history).
//
// 11-autopilot-ui-reframe m2. Consumes GET /api/career/autopilot/review.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle, Loader2, CheckCircle2, ExternalLink, PenLine, Send,
} from 'lucide-react'
import './review.css'

const REFRESH_MS = 30_000

type ReviewItem = {
  jobId: string
  company: string | null
  role: string | null
  ats: string | null
  job_url: string | null
  status: string
  filledCount: number
  escalationCode: string | null
  last_activity_at: string | null
}
type ReviewResp = {
  groups: { submit: ReviewItem[]; failed: ReviewItem[]; filling: ReviewItem[] }
  counts: { submit: number; failed: number; filling: number }
}

function relTime(iso: string | null): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  const m = 60_000, h = 60 * m, d = 24 * h
  if (diff < m) return 'just now'
  if (diff < h) return `${Math.floor(diff / m)}m ago`
  if (diff < d) return `${Math.floor(diff / h)}h ago`
  return `${Math.floor(diff / d)}d ago`
}

export default function Review() {
  const [data, setData] = useState<ReviewResp | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const mounted = useRef(true)

  const fetchReview = useCallback(async (signal?: AbortSignal) => {
    try {
      const r = await fetch('/api/career/autopilot/review', { signal })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = (await r.json()) as ReviewResp
      if (!mounted.current) return
      setData(j)
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
    fetchReview(ctrl.signal)
    const t = setInterval(() => fetchReview(ctrl.signal), REFRESH_MS)
    return () => { mounted.current = false; ctrl.abort(); clearInterval(t) }
  }, [fetchReview])

  if (loading && !data) {
    return <div className="c-page rv-page"><p className="rv-muted"><Loader2 size={14} className="rv-spin" /> Loading…</p></div>
  }

  const g = data?.groups ?? { submit: [], failed: [], filling: [] }
  const empty = g.submit.length + g.failed.length + g.filling.length === 0

  return (
    <div className="c-page rv-page">
      <h2>待办闸门</h2>
      <p className="rv-sub">机器填好的申请停在这里等你。点 [去处理] 在浏览器里审核并提交;答一道新问题会存进 Q&A 库,下次自动填。</p>

      {error && <p className="rv-error"><AlertTriangle size={14} /> {error}</p>}

      {empty && !error && (
        <div className="rv-empty">
          <CheckCircle2 size={28} />
          <strong>收件箱清空了 🎉</strong>
          <p>没有待处理的申请。打开 Autopilot,机器投递后停在闸门的会出现在这里。</p>
          <Link to="/career/dashboard" className="rv-btn rv-btn-ghost">← 回 Dashboard</Link>
        </div>
      )}

      {g.submit.length > 0 && (
        <Bucket title="🟢 待提交" hint="已填到 submit gate — 审核后在浏览器点 Submit" items={g.submit} tone="ok" bankable />
      )}
      {g.failed.length > 0 && (
        <Bucket title="🔴 需接管" hint="登录墙 / 超时 / 失败 — 需要你手动接管" items={g.failed} tone="bad" />
      )}
      {g.filling.length > 0 && (
        <Bucket title="⚪ 填表中" hint="机器正在填,无需操作" items={g.filling} tone="muted" />
      )}
    </div>
  )
}

function Bucket({ title, hint, items, tone, bankable }: {
  title: string; hint: string; items: ReviewItem[]; tone: string; bankable?: boolean
}) {
  return (
    <section className={`rv-bucket rv-tone-${tone}`}>
      <div className="rv-bucket-head">
        <h3>{title} <span className="rv-count">{items.length}</span></h3>
        <span className="rv-bucket-hint">{hint}</span>
      </div>
      <ul className="rv-list">
        {items.map((it) => <ReviewCard key={it.jobId} item={it} bankable={bankable} />)}
      </ul>
    </section>
  )
}

function ReviewCard({ item, bankable }: { item: ReviewItem; bankable?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="rv-card">
      <div className="rv-card-main">
        <div className="rv-card-title">
          {item.company || item.jobId}{item.role ? <span className="rv-card-role"> · {item.role}</span> : null}
        </div>
        <div className="rv-card-meta">
          {item.ats && <span className="rv-tag">{item.ats}</span>}
          <span>{item.filledCount} 字段已填</span>
          {item.escalationCode && <span className="rv-tag rv-tag-warn">{item.escalationCode}</span>}
          {item.last_activity_at && <span className="rv-card-time">{relTime(item.last_activity_at)}</span>}
        </div>
      </div>
      <div className="rv-card-actions">
        {item.job_url && (
          <a href={item.job_url} target="_blank" rel="noreferrer" className="rv-btn rv-btn-ghost"><ExternalLink size={13} /> JD</a>
        )}
        <Link to={`/career/apply/${encodeURIComponent(item.jobId)}`} className="rv-btn rv-btn-primary"><Send size={13} /> 去处理</Link>
        {bankable && (
          <button type="button" className="rv-btn rv-btn-ghost" onClick={() => setOpen((o) => !o)}>
            <PenLine size={13} /> 存答案
          </button>
        )}
      </div>
      {open && <BankAnswer jobId={item.jobId} onDone={() => setOpen(false)} />}
    </li>
  )
}

function BankAnswer({ jobId, onDone }: { jobId: string; onDone: () => void }) {
  const [label, setLabel] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const mounted = useRef(true)
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    mounted.current = false
    if (doneTimer.current) clearTimeout(doneTimer.current)
  }, [])

  async function save() {
    if (!label.trim() || !answer.trim() || busy) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await fetch('/api/career/autopilot/bank-answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim(), final_answer: answer.trim(), jobId }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      if (!mounted.current) return
      setMsg('✓ 已存入 Q&A 库 — 下次同类问题自动填')
      setLabel(''); setAnswer('')
      doneTimer.current = setTimeout(() => { if (mounted.current) onDone() }, 1200)
    } catch (e) {
      if (mounted.current) setMsg(`保存失败:${e instanceof Error ? e.message : ''}`)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <div className="rv-bank">
      <input className="rv-bank-label" placeholder="机器问了什么?(问题/字段名)" value={label} onChange={(e) => setLabel(e.target.value)} />
      <textarea className="rv-bank-answer" placeholder="你的答案……" value={answer} onChange={(e) => setAnswer(e.target.value)} rows={2} />
      <div className="rv-bank-foot">
        <span className="rv-bank-hint">💡 答一次,存进 Q&A 库,下次机器自动填</span>
        <button type="button" className="rv-btn rv-btn-primary" disabled={busy || !label.trim() || !answer.trim()} onClick={save}>
          {busy ? <Loader2 size={13} className="rv-spin" /> : <PenLine size={13} />} 保存
        </button>
      </div>
      {msg && <p className={`rv-bank-msg${msg.startsWith('✓') ? ' rv-bank-msg-ok' : ' rv-bank-msg-bad'}`}>{msg}</p>}
    </div>
  )
}

// re-export the count shape so the nav badge can fetch the same endpoint.
export type { ReviewResp }
