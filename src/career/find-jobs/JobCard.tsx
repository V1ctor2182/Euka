// Reusable job card — used by Find Jobs main grid AND Raw Jobs drawer.
//
// 04-career-system / find-jobs-redesign m1.b + m1.c.
//
// Two modes:
//   - kind='passed':  show score pill + [View] / [Apply]
//   - kind='dropped': show DROPPED badge + dropped_by reason + [Adjust filter]

import { ExternalLink, Eye, Bot, AlertTriangle, Filter, Loader2, Inbox, Check } from 'lucide-react'

// What the autopilot machine is doing with this job (null = untouched).
export type MachineState = 'queued' | 'filling' | 'submit' | 'failed' | null

export type JobCardModel = {
  id: string
  company: string
  role: string
  location: string[] | string | null
  url: string
  source: { type: string; name: string } | null
  tags?: string[] | null
  comp_hint?: string | null
  posted_at?: string | null
  // present on passed jobs (after Stage A)
  evaluation?: { stage_a?: { score: number } | null; stage_b?: { score: number } | null } | null
  // present on raw-jobs entries
  _passed?: boolean
  _dropped_by?: string | null
  _dropped_detail?: string | null
}

type Props = {
  job: JobCardModel
  onView?: (job: JobCardModel) => void
  onApply?: (job: JobCardModel) => void  // "让机器投" — enqueue for the daemon
  onAdjustFilter?: (job: JobCardModel) => void
  machineState?: MachineState
  onOpenReview?: () => void
}

export default function JobCard({ job, onView, onApply, onAdjustFilter, machineState, onOpenReview }: Props) {
  const dropped = job._passed === false
  const score = job.evaluation?.stage_a?.score
  const tier =
    typeof score === 'number'
      ? score >= 4 ? 'good' : score >= 3 ? 'warn' : 'bad'
      : 'unrated'
  const locText = Array.isArray(job.location)
    ? job.location.slice(0, 2).join(' · ') + (job.location.length > 2 ? ` +${job.location.length - 2}` : '')
    : (job.location ?? '')

  return (
    <article className={`c-fj-card ${dropped ? 'c-fj-card-dropped' : `c-fj-card-${tier}`}`}>
      <header className="c-fj-card-head">
        <div className="c-fj-card-company-row">
          {!dropped && <ScoreDot tier={tier} />}
          {dropped && <span className="c-fj-card-dot c-fj-card-dot-dropped" aria-label="dropped">✕</span>}
          <span className="c-fj-card-company" title={job.company}>{job.company}</span>
          {job.source && (
            <span className="c-fj-card-source">{job.source.type}</span>
          )}
        </div>
        <h4 className="c-fj-card-role" title={job.role}>{job.role}</h4>
      </header>

      <div className="c-fj-card-body">
        {locText && <div className="c-fj-card-meta">📍 {locText}</div>}
        {job.comp_hint && <div className="c-fj-card-meta c-fj-card-comp">💰 {job.comp_hint}</div>}
        {job.posted_at && <div className="c-fj-card-meta">📅 {formatRelative(job.posted_at)}</div>}
      </div>

      {dropped && (
        <div className="c-fj-card-drop-reason">
          <AlertTriangle size={12} />
          <div className="c-fj-card-drop-text">
            <strong>{prettifyRule(job._dropped_by)}</strong>
            {job._dropped_detail && (
              <>
                <br />
                <code className="c-fj-card-drop-detail">{job._dropped_detail}</code>
              </>
            )}
          </div>
        </div>
      )}

      <footer className="c-fj-card-foot">
        {!dropped && typeof score === 'number' && (
          <span className="c-fj-card-score">⭐ {score.toFixed(1)}</span>
        )}
        <div className="c-fj-card-actions">
          <a
            className="c-fj-btn c-fj-btn-ghost"
            href={job.url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open posting"
            aria-label="Open posting"
          >
            <ExternalLink size={13} />
          </a>
          {!dropped && onView && (
            <button type="button" className="c-fj-btn c-fj-btn-ghost" onClick={() => onView(job)}>
              <Eye size={13} /> View
            </button>
          )}
          {!dropped && <MachineAction state={machineState ?? null} onApply={onApply ? () => onApply(job) : undefined} onOpenReview={onOpenReview} />}
          {dropped && onAdjustFilter && (
            <button
              type="button"
              className="c-fj-btn c-fj-btn-ghost"
              onClick={() => onAdjustFilter(job)}
              title="Open filter section + highlight the rule that dropped this job"
            >
              <Filter size={13} /> Adjust filter
            </button>
          )}
        </div>
      </footer>
    </article>
  )
}

// The autopilot action button — reflects what the machine is doing with the job.
function MachineAction({ state, onApply, onOpenReview }: { state: MachineState; onApply?: () => void; onOpenReview?: () => void }) {
  if (state === 'filling') {
    return <span className="c-fj-btn c-fj-btn-state" title="机器正在填这个表"><Loader2 size={13} className="c-fj-spin" /> 填表中</span>
  }
  if (state === 'queued') {
    return <span className="c-fj-btn c-fj-btn-state" title="已排队 — 打开 Autopilot 让机器投"><Inbox size={13} /> 已排队</span>
  }
  if (state === 'submit') {
    return <button type="button" className="c-fj-btn c-fj-btn-primary" onClick={onOpenReview} title="已填好,去 Review 提交"><Check size={13} /> 待提交</button>
  }
  if (state === 'failed') {
    return <button type="button" className="c-fj-btn c-fj-btn-ghost" onClick={onOpenReview} title="填表失败,去 Review 接管"><AlertTriangle size={13} /> 需接管</button>
  }
  // untouched → offer to hand it to the machine
  return onApply ? (
    <button type="button" className="c-fj-btn c-fj-btn-primary" onClick={onApply} title="让机器自动填这个表(停在 submit gate,不自动提交)">
      <Bot size={13} /> 让机器投
    </button>
  ) : null
}

function ScoreDot({ tier }: { tier: 'good' | 'warn' | 'bad' | 'unrated' }) {
  const glyph = tier === 'good' ? '🟢' : tier === 'warn' ? '🟡' : tier === 'bad' ? '🟠' : '⚪'
  return <span className="c-fj-card-dot" aria-label={tier}>{glyph}</span>
}

function prettifyRule(rule: string | null | undefined): string {
  if (!rule) return 'dropped'
  return rule
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const days = Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000))
  if (days === 0) return 'today'
  if (days === 1) return '1d ago'
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return new Date(t).toISOString().slice(0, 10)
}
