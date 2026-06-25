import { NavLink } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import {
  LayoutDashboard,
  Gauge,
  Inbox,
  Search,
  Send,
  User,
  ChevronDown,
  MoreHorizontal,
  MessagesSquare,
  FileBarChart,
} from 'lucide-react'

// autopilot-ui-reframe m4: the nav now mirrors the autopilot closed loop —
// Dashboard (control) → Review (human gate) → Jobs (transparency) → Tracker
// (results) → Profile (config). Legacy Overview/Pipeline/Shortlist are dropped
// from the nav (their routes redirect to replacements so bookmarks don't 404);
// the debug pages (Learning/Iteration) moved into Profile → Dev/Debug.
const PRIMARY_TABS: Array<{ to: string; label: string; Icon: typeof LayoutDashboard; badgeKey?: string }> = [
  { to: '/dashboard', label: 'Dashboard', Icon: Gauge },
  { to: '/review', label: 'Review', Icon: Inbox, badgeKey: 'review' },
  { to: '/find-jobs', label: 'Jobs', Icon: Search },
  { to: '/applied', label: 'Tracker', Icon: Send },
  { to: '/settings', label: 'Profile', Icon: User },
]

const REVIEW_BADGE_REFRESH_MS = 30_000

// "More" overflow — real-but-secondary user pages (not the daily loop).
const ADVANCED_TABS: Array<{ to: string; label: string; Icon: typeof LayoutDashboard }> = [
  { to: '/prep', label: 'Interview Prep', Icon: MessagesSquare },
  { to: '/reports', label: 'Reports', Icon: FileBarChart },
]

export default function CareerNav() {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // Review badge: count of items awaiting your action (submit-ready). Polled so
  // the nav reflects new parked applications without a page reload.
  const [reviewCount, setReviewCount] = useState(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    const ctrl = new AbortController()
    const poll = async () => {
      try {
        const r = await fetch('/api/career/autopilot/review', { signal: ctrl.signal })
        if (!r.ok) return
        const j = await r.json()
        if (mounted.current) setReviewCount(j?.counts?.submit ?? 0)
      } catch { /* badge is best-effort */ }
    }
    poll()
    const t = setInterval(poll, REVIEW_BADGE_REFRESH_MS)
    return () => { mounted.current = false; ctrl.abort(); clearInterval(t) }
  }, [])

  const badges: Record<string, number> = { review: reviewCount }
  return (
    <nav className="c-nav" aria-label="Career sections">
      {PRIMARY_TABS.map(({ to, label, Icon, badgeKey }) => {
        const badge = badgeKey ? badges[badgeKey] : 0
        return (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `c-nav-tab${isActive ? ' c-nav-tab-active' : ''}`}
          >
            <Icon size={16} />
            <span>{label}</span>
            {badge > 0 && <span className="c-nav-badge">{badge}</span>}
          </NavLink>
        )
      })}
      <div className="c-nav-advanced-wrap">
        <button
          type="button"
          className="c-nav-tab c-nav-advanced-toggle"
          onClick={() => setAdvancedOpen((o) => !o)}
          aria-expanded={advancedOpen}
        >
          <MoreHorizontal size={16} />
          <span>More</span>
          <ChevronDown size={12} />
        </button>
        {advancedOpen && (
          <div className="c-nav-advanced-menu" onClick={() => setAdvancedOpen(false)}>
            {ADVANCED_TABS.map(({ to, label, Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) => `c-nav-advanced-item${isActive ? ' c-nav-advanced-item-active' : ''}`}
              >
                <Icon size={14} />
                <span>{label}</span>
              </NavLink>
            ))}
          </div>
        )}
      </div>
    </nav>
  )
}
