import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import CareerApp from './CareerApp'

// Standalone Euka — the career system lives at /career/* (preserving the
// in-app links that hardcode that prefix). Root redirects into it.
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/career" replace />} />
        <Route path="/career/*" element={<CareerApp />} />
        <Route path="*" element={<Navigate to="/career" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
