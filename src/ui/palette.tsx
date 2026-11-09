import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from './kit';

export type PaletteEntry = { id: string; group: string; label: string; hint?: string; icon: string; to: string; keywords?: string };

/**
 * Console-wide search (Ctrl/⌘ K or "/"): jump to any page, start an action, or open a device,
 * employee or console user by name, serial, model or e-mail.
 */
export function CommandPalette({ open, onClose, pages }: { open: boolean; onClose: () => void; pages: PaletteEntry[] }) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const [devices] = useQuery((api) => api.listDevices(), [open], { enabled: open, live: false });
  const [employees] = useQuery((api) => api.listEmployees(), [open], { enabled: open, live: false });
  const [users] = useQuery((api) => api.listUsers(), [open], { enabled: open, live: false });

  useEffect(() => {
    if (!open) return;
    setQ('');
    setActive(0);
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  const results = useMemo(() => {
    const all: PaletteEntry[] = [
      ...pages,
      ...(devices ?? []).map((d) => ({
        id: `dev-${d.id}`,
        group: 'Devices',
        icon: '▤',
        label: d.displayName,
        hint: [d.model, d.serial !== 'unknown' ? d.serial : null, d.assignedUser?.name, d.state].filter(Boolean).join(' · '),
        to: `/devices/${d.id}`,
        keywords: `${d.id} ${d.serial ?? ''} ${d.model ?? ''} ${d.assignedUser?.email ?? ''}`,
      })),
      ...(employees ?? []).map((e) => ({ id: `emp-${e.id}`, group: 'Employees', icon: '☺', label: e.name, hint: `${e.email} · ${e.department}`, to: '/employees', keywords: e.email })),
      ...(users ?? []).map((u) => ({ id: `usr-${u.id}`, group: 'Console users', icon: '⚿', label: u.name, hint: u.email, to: '/users', keywords: `${u.email} ${u.role}` })),
    ];
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return all.filter((x) => x.group === 'Go to' || x.group === 'Actions');
    return all
      .filter((x) => {
        const hay = `${x.label} ${x.hint ?? ''} ${x.keywords ?? ''} ${x.group}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      })
      .slice(0, 40);
  }, [q, pages, devices, employees, users]);

  // Typing resets the highlight to the best match. The pointer only changes it when it really moves
  // (onMouseMove): a list opening under a resting cursor must not steal the keyboard selection.
  useEffect(() => setActive(0), [q]);
  if (!open) return null;

  const go = (x: PaletteEntry | undefined) => {
    if (!x) return;
    onClose();
    nav(x.to);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(results[active]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };
  let lastGroup = '';
  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search the console">
        <div className="palette-input">
          <span aria-hidden>⌕</span>
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search devices, people, pages or actions…"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={results[active] ? `pal-${results[active].id}` : undefined}
            aria-label="Search the console"
          />
          <kbd>Esc</kbd>
        </div>
        <ul id="palette-list" role="listbox" className="palette-list">
          {results.length === 0 && <li className="palette-empty">No matches for “{q}”.</li>}
          {results.map((x, i) => {
            const header = x.group !== lastGroup ? (lastGroup = x.group) : null;
            return (
              <li key={x.id} role="presentation">
                {header && <div className="palette-group">{header}</div>}
                <div
                  id={`pal-${x.id}`}
                  role="option"
                  aria-selected={i === active}
                  className={`palette-item${i === active ? ' active' : ''}`}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => go(x)}
                >
                  <span className="palette-icon" aria-hidden>
                    {x.icon}
                  </span>
                  <span className="palette-text">
                    <span>{x.label}</span>
                    {x.hint && <small>{x.hint}</small>}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> to move · <kbd>Enter</kbd> to open
          </span>
          <span>
            <kbd>Ctrl</kbd> <kbd>K</kbd> anywhere
          </span>
        </div>
      </div>
    </div>
  );
}
