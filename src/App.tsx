import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import CareerApp from './CareerApp'

// Standalone Euka — the autopilot career product lives at the root (/dashboard,
// /review, /jobs, …). Old /career/* bookmarks redirect to the de-prefixed path.
function LegacyCareerRedirect() {
  const { pathname, search } = useLocation()
  const stripped = pathname.replace(/^\/career(?=\/|$)/, '') || '/'
  return <Navigate to={stripped + search} replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/career/*" element={<LegacyCareerRedirect />} />
        <Route path="/*" element={<CareerApp />} />
      </Routes>
    </BrowserRouter>
  )
}
