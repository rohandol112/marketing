import React, { createContext, useContext, useCallback, useEffect, useState } from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import api, { setActingUser, getActingUser } from './api.js';

import Discovery from './pages/Discovery.jsx';
import Review from './pages/Review.jsx';
import Board from './pages/Board.jsx';
import Analytics from './pages/Analytics.jsx';
import Settings from './pages/Settings.jsx';

/* ---------------- toasts ---------------- */

const ToastCtx = createContext(null);
export const useToast = () => useContext(ToastCtx);

function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const push = useCallback((message, kind = 'info', ms = 4500) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
  }, []);

  const value = {
    info: (m) => push(m, 'info'),
    success: (m) => push(m, 'success'),
    error: (m) => push(typeof m === 'string' ? m : m?.message || 'Something went wrong', 'error', 7000),
  };

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={'toast ' + t.kind}>{t.message}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------------- app data ---------------- */

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

function AppDataProvider({ children }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    try {
      const d = await api.bootstrap();
      setData(d);
      setError(null);
      if (!getActingUser() && d.currentUser) setActingUser(d.currentUser.id);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  if (error) {
    return (
      <div className="empty" style={{ paddingTop: 90 }}>
        <h3>Cannot reach the API</h3>
        <p>{error.message}</p>
        <p className="small faint">
          Start Postgres with <code className="mono">docker compose up -d</code>, then run{' '}
          <code className="mono">npm run setup</code> and <code className="mono">npm run dev</code> in <code className="mono">/server</code>.
        </p>
        <button className="btn" onClick={reload}>Try again</button>
      </div>
    );
  }

  if (!data) {
    return <div className="empty" style={{ paddingTop: 90 }}><span className="spinner" /> <span className="muted">Loading</span></div>;
  }

  return <AppCtx.Provider value={{ ...data, reload }}>{children}</AppCtx.Provider>;
}

/* ---------------- shell ---------------- */

function Shell() {
  const app = useApp();
  const [userId, setUserId] = useState(getActingUser());

  const onUserChange = (id) => {
    setActingUser(id);
    setUserId(id);
    window.location.reload();
  };

  // Label the source that is actually being used. Reading placesMock here was
  // wrong: it made real OpenStreetMap and Gemini runs read as "Mock leads".
  const SOURCE_BADGE = {
    places: { text: 'Google Places', cls: 'a', why: 'Authoritative discovery with ratings and review counts.' },
    osm:    { text: 'OpenStreetMap', cls: 'blue', why: 'Real mapped businesses, free. No ratings, so leads need a review count before they qualify.' },
    gemini: { text: 'AI recall - unverified', cls: 'b', why: 'The model is listing businesses from memory. Every lead needs a human check before a rep sees it.' },
    mock:   { text: 'Mock data', cls: 'c', why: 'Synthetic leads for working on the UI.' },
  };
  const src = SOURCE_BADGE[app.modes.discoverySource] || SOURCE_BADGE.mock;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="brand-dot" />{app.tenant?.name || 'Sales Agent'}</div>
        <nav className="nav">
          <NavLink to="/board">Board</NavLink>
          <NavLink to="/review">Review Queue</NavLink>
          <NavLink to="/discovery">Discovery</NavLink>
          <NavLink to="/analytics">Analytics</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="topbar-right">
          <span className={'badge ' + src.cls} title={src.why}>{src.text}</span>
          {app.modes.geminiMock && (
            <span className="badge c" title="No GEMINI_API_KEY - briefs and messages fall back to templates.">
              Template AI
            </span>
          )}
          <select
            value={userId || ''}
            onChange={(e) => onUserChange(e.target.value)}
            style={{ width: 'auto', minWidth: 150 }}
            title="Acting as - swaps whose board and caps you see"
          >
            {app.users.map((u) => (
              <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
            ))}
          </select>
        </div>
      </header>

      <Routes>
        <Route path="/" element={<Navigate to="/board" replace />} />
        <Route path="/board" element={<Board />} />
        <Route path="/review" element={<Review />} />
        <Route path="/discovery" element={<Discovery />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AppDataProvider>
        <Shell />
      </AppDataProvider>
    </ToastProvider>
  );
}
