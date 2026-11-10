import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Card, Empty, ErrorBox, fmtAgo, fmtTime, TableWrap, useAction, useCan, useQuery, useRuntime } from '../ui/kit';
import type { DeviceView } from '../core/backend';
import type { DeviceInventory } from '../core/types';
import { PLATFORM_LABEL } from '../ui/platform';

type Tab = 'overview' | 'settings' | 'storage' | 'network' | 'software';

/** The full configuration snapshot a device reported: hardware, OS, disks, network, settings, programs. */
export function InventoryCard({ device }: { device: DeviceView }) {
  const rt = useRuntime();
  const [inv, err] = useQuery((api) => api.getInventory(device.id), [device.id, device.inventoryAt]);
  const canCollect = useCan('command.COLLECT_INVENTORY');
  const { run, busy } = useAction();
  const [tab, setTab] = useState<Tab>('overview');
  const [q, setQ] = useState('');
  const d = inv?.data;
  const tabs: [Tab, string, number | null][] = d
    ? [
        ['overview', 'Overview', null],
        ['settings', 'Settings', d.settings.length],
        ['storage', 'Storage', d.disks.length],
        ['network', 'Network', d.network.length],
        ['software', 'Software', d.software.length],
      ]
    : [];
  const unsupported = device.platform === 'ios' || device.state === 'retired' || device.state === 'wiped';
  return (
    <Card
      title="Inventory"
      actions={
        canCollect && !unsupported ? (
          <button
            className="btn btn-sm"
            disabled={busy || !!device.pendingRemoval}
            onClick={() => void run(() => rt.api.issueCommand(device.id, { type: 'COLLECT_INVENTORY' }), 'Inventory requested — it arrives at the next sync')}
          >
            ⟳ Refresh inventory
          </button>
        ) : undefined
      }
    >
      {err && <ErrorBox>{err}</ErrorBox>}
      {!inv ? (
        <Empty>No inventory yet. It is uploaded after enrolment and every 6 hours{canCollect ? ' — or use Refresh inventory.' : '.'}</Empty>
      ) : (
        <>
          <p className="small muted">
            Collected {fmtAgo(d!.collectedAt || inv.receivedAt)} by agent {d!.agentVersion || '—'} · received {fmtTime(inv.receivedAt)}
          </p>
          <div className="tabs" role="tablist" aria-label="Inventory sections">
            {tabs.map(([id, label, n]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={`tab ${tab === id ? 'tab-on' : ''}`} onClick={() => setTab(id)}>
                {label} {n !== null && <span className="tab-count">{n}</span>}
              </button>
            ))}
          </div>
          {tab === 'overview' && <Overview d={d!} />}
          {tab === 'settings' && <Settings d={d!} />}
          {tab === 'storage' && <Storage d={d!} />}
          {tab === 'network' && <Network d={d!} />}
          {tab === 'software' && <Software d={d!} q={q} setQ={setQ} platform={device.platform} />}
        </>
      )}
    </Card>
  );
}

function KV({ rows }: { rows: [string, string | number | undefined | null][] }) {
  const shown = rows.filter(([, v]) => v !== undefined && v !== null && v !== '');
  return (
    <dl className="kv">
      {shown.map(([k, v]) => (
        <div key={k} className="kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Overview({ d }: { d: DeviceInventory }) {
  return (
    <div className="inv-grid">
      <section>
        <h3>System</h3>
        <KV
          rows={[
            ['Hostname', d.system.hostname],
            ['Manufacturer', d.system.manufacturer],
            ['Model', d.system.model],
            ['Serial number', d.system.serial],
            ['Form factor', d.system.chassis],
            ['Firmware', d.system.firmware],
          ]}
        />
      </section>
      <section>
        <h3>Operating system</h3>
        <KV
          rows={[
            ['Name', d.os.name],
            ['Version', d.os.version],
            ['Build', d.os.build],
            ['Kernel', d.os.kernel],
            ['Architecture', d.os.arch],
            ['Installed', d.os.installDate],
            ['Last boot', d.os.lastBoot ? fmtTime(Date.parse(d.os.lastBoot)) : undefined],
            ['Time zone', d.os.timezone],
          ]}
        />
      </section>
      <section>
        <h3>Hardware</h3>
        <KV
          rows={[
            ['Processor', d.hardware.cpu],
            ['Cores / threads', d.hardware.cores ? `${d.hardware.cores} / ${d.hardware.threads ?? '—'}` : d.hardware.threads],
            ['Memory', d.hardware.memoryGb ? `${d.hardware.memoryGb} GB` : undefined],
            ['TPM / secure element', d.hardware.tpm],
          ]}
        />
      </section>
    </div>
  );
}

function Settings({ d }: { d: DeviceInventory }) {
  const groups = useMemo(() => {
    const m = new Map<string, DeviceInventory['settings']>();
    for (const s of d.settings) m.set(s.category, [...(m.get(s.category) ?? []), s]);
    return [...m];
  }, [d]);
  if (!groups.length) return <Empty>No settings reported.</Empty>;
  return (
    <div className="inv-grid">
      {groups.map(([cat, rows]) => (
        <section key={cat}>
          <h3>{cat}</h3>
          <KV rows={rows.map((r) => [r.name, r.value])} />
        </section>
      ))}
    </div>
  );
}

function Storage({ d }: { d: DeviceInventory }) {
  if (!d.disks.length) return <Empty>No volumes reported.</Empty>;
  return (
    <TableWrap label="Volumes">
      <table>
        <thead>
          <tr>
            <th>Volume</th>
            <th>File system</th>
            <th>Size</th>
            <th>Free</th>
            <th>Encrypted</th>
          </tr>
        </thead>
        <tbody>
          {d.disks.map((x) => (
            <tr key={x.mount}>
              <td>
                <code>{x.mount}</code>
              </td>
              <td>{x.fs ?? '—'}</td>
              <td>{x.sizeGb} GB</td>
              <td>
                {x.freeGb} GB {x.sizeGb > 0 && x.freeGb / x.sizeGb < 0.1 && <Badge tone="warn">low</Badge>}
              </td>
              <td>{x.encrypted === undefined ? '—' : <Badge tone={x.encrypted ? 'ok' : 'bad'}>{x.encrypted ? 'Yes' : 'No'}</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function Network({ d }: { d: DeviceInventory }) {
  if (!d.network.length) return <Empty>No network adapters reported.</Empty>;
  return (
    <TableWrap label="Network adapters">
      <table>
        <thead>
          <tr>
            <th>Adapter</th>
            <th>MAC address</th>
            <th>IP addresses</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {d.network.map((n) => (
            <tr key={`${n.name}-${n.mac}`}>
              <td>{n.name}</td>
              <td>
                <code>{n.mac ?? '—'}</code>
              </td>
              <td className="small">{[...(n.ipv4 ?? []), ...(n.ipv6 ?? [])].join(', ') || '—'}</td>
              <td>
                <Badge tone={n.up ? 'ok' : 'neutral'}>{n.up ? 'Up' : 'Down'}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function Software({ d, q, setQ, platform }: { d: DeviceInventory; q: string; setQ: (s: string) => void; platform: DeviceView['platform'] }) {
  const terms = q.trim().toLowerCase();
  const shown = d.software.filter((a) => !terms || `${a.name} ${a.publisher ?? ''} ${a.version ?? ''}`.toLowerCase().includes(terms));
  if (!d.software.length)
    return <Empty>{platform === 'android' ? 'Phones report only apps installed from the company catalogue — none yet.' : 'No installed programs reported.'}</Empty>;
  return (
    <>
      <div className="toolbar">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${d.software.length} programs…`} aria-label="Search installed programs" />
        <Link className="small" to={`/software${q ? `?q=${encodeURIComponent(q)}` : ''}`}>
          Across the fleet →
        </Link>
      </div>
      <TableWrap label="Installed programs">
        <table>
          <thead>
            <tr>
              <th>Program</th>
              <th>Version</th>
              <th>Publisher</th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, 300).map((a, i) => (
              <tr key={`${a.name}-${a.version}-${i}`}>
                <td>{a.name}</td>
                <td className="small">{a.version ?? '—'}</td>
                <td className="small muted">{a.publisher ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      {shown.length > 300 && <p className="small muted">Showing 300 of {shown.length} — refine the search.</p>}
    </>
  );
}

/** Every installed program across the fleet, with the versions and devices that have it. */
export function SoftwarePage() {
  const initial = new URLSearchParams(location.hash.split('?')[1] ?? '').get('q') ?? '';
  const [q, setQ] = useState(initial);
  const [rows, err] = useQuery((api) => api.listSoftware(q), [q], { live: false });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="page">
      <h1>Software inventory</h1>
      <p className="muted">Programs installed on managed computers (and catalogue apps on phones), from each device&apos;s latest inventory. Find outdated or unwanted software fast.</p>
      <div className="toolbar">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search programs or publishers…" aria-label="Search software" autoFocus />
        {rows && <span className="small muted">{rows.length === 500 ? '500+' : rows.length} programs</span>}
      </div>
      {err && <ErrorBox>{err}</ErrorBox>}
      <Card>
        {rows?.length ? (
          <ul className="software-list">
            {rows.map((r) => (
              <li key={r.name}>
                <button className="software-row" aria-expanded={open === r.name} onClick={() => setOpen(open === r.name ? null : r.name)}>
                  <span>
                    <strong>{r.name}</strong>
                    {r.publisher && <small className="muted"> · {r.publisher}</small>}
                  </span>
                  <span className="small">
                    {r.versions.length} version{r.versions.length === 1 ? '' : 's'} · <Badge tone="info">{r.deviceCount} device{r.deviceCount === 1 ? '' : 's'}</Badge>
                  </span>
                </button>
                {open === r.name && (
                  <ul className="software-versions">
                    {r.versions.map((v) => (
                      <li key={v.version}>
                        <code>{v.version || 'unknown version'}</code> —{' '}
                        {v.devices.map((dv, i) => (
                          <span key={dv.id}>
                            {i > 0 && ', '}
                            <Link to={`/devices/${dv.id}`}>{dv.name}</Link> <span className="muted tiny">({PLATFORM_LABEL[dv.platform]})</span>
                          </span>
                        ))}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{q ? `No program matches “${q}”.` : 'No inventory yet. Computers upload theirs after enrolment and every 6 hours.'}</Empty>
        )}
      </Card>
    </div>
  );
}
