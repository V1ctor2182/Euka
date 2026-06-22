import { NavLink, Outlet } from 'react-router-dom'
import {
  User, SlidersHorizontal, Globe, FileQuestion, BookText, BadgeCheck,
  FileText, KeyRound, TrendingDown, Activity,
} from 'lucide-react'

// autopilot-ui-reframe m4: Profile is the machine's "training data". Group the
// settings into 「机器怎么填」(who you are) + 「机器怎么找」(sources/filters) +
// 「集成 & 调试」(creds + the debug pages pulled out of the main nav).
type Item = { to: string; label: string; Icon: typeof User; absolute?: boolean }
type Group = { title: string; items: Item[] }

const GROUPS: Group[] = [
  {
    title: '机器怎么填',
    items: [
      { to: 'identity', label: 'Identity', Icon: User },
      { to: 'resumes', label: 'Resumes', Icon: FileText },
      { to: 'qa-bank', label: 'QA Bank', Icon: FileQuestion },
      { to: 'narrative', label: 'Narrative', Icon: BookText },
      { to: 'proof-points', label: 'Proof Points', Icon: BadgeCheck },
    ],
  },
  {
    title: '机器怎么找',
    items: [
      { to: 'preferences', label: 'Filters', Icon: SlidersHorizontal },
      { to: 'portals', label: 'Sources', Icon: Globe },
    ],
  },
  {
    title: '集成 & 调试',
    items: [
      { to: 'integrations', label: 'Integrations', Icon: KeyRound },
      // Debug pages — pulled out of the main nav (absolute paths: they render as
      // full pages, not inside the settings Outlet).
      { to: '/career/learning', label: 'Learning (debug)', Icon: TrendingDown, absolute: true },
      { to: '/career/iteration', label: 'Iteration (debug)', Icon: Activity, absolute: true },
    ],
  },
]

export default function SettingsLayout() {
  return (
    <div className="c-settings-layout">
      <aside className="c-settings-sidebar" aria-label="Settings sections">
        {GROUPS.map((group) => (
          <div key={group.title} className="c-settings-group">
            <div className="c-settings-group-title">{group.title}</div>
            {group.items.map(({ to, label, Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `c-settings-sidebar-link${isActive ? ' c-settings-sidebar-link-active' : ''}`
                }
              >
                <Icon size={16} />
                <span>{label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </aside>

      <section className="c-settings-content">
        <Outlet />
      </section>
    </div>
  )
}
