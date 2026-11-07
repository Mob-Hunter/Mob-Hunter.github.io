import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Runtime } from './runtime';
import { RuntimeProvider, ToastHost } from './ui/kit';
import { isOffServer } from './config';
import { Landing } from './pages/Landing';
import './styles.css';

// Boot once even if React StrictMode runs effects twice in development.
let booting: Promise<Runtime> | null = null;

function Boot() {
  const [rt, setRt] = useState<Runtime | null>(null);
  const [msg, setMsg] = useState('Starting…');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    (booting ??= Runtime.boot(setMsg)).then(setRt, (e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  if (err)
    return (
      <div className="boot">
        <p>Could not start: {err}</p>
        <p className="small">This app needs a modern browser with Web Crypto (Chrome, Edge, Firefox, Safari 17+).</p>
      </div>
    );
  if (!rt)
    return (
      <div className="boot" role="status">
        <div className="spinner" aria-hidden />
        <p>{msg}</p>
      </div>
    );
  return (
    <RuntimeProvider value={rt}>
      <ToastHost>
        <App />
      </ToastHost>
    </RuntimeProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isOffServer() ? <Landing /> : <Boot />}</StrictMode>,
);
