import { useRef, useState } from 'react';
import { Badge, Card, Empty, ErrorBox, Field, download, useAction, useCan, useQuery, useRuntime } from '../ui/kit';
import { csvObjects, toCsv } from '../ui/csv';
import type { Employee } from '../core/types';

export function EmployeesPage() {
  const rt = useRuntime();
  const [emps, err] = useQuery((api) => api.listEmployees());
  const [devices] = useQuery((api) => api.listDevices());
  const canManage = useCan('employee.manage');
  const canDsar = useCan('privacy.dsar');
  const [q, setQ] = useState('');
  const [showLeavers, setShowLeavers] = useState(false);
  const { run, busy } = useAction();

  const devicesOf = (id: string) => (devices ?? []).filter((d) => d.assignedUserId === id);
  const shown = (emps ?? [])
    .filter((e) => showLeavers || e.status !== 'leaver')
    .filter((e) => (q ? `${e.name} ${e.email} ${e.department}`.toLowerCase().includes(q.toLowerCase()) : true))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="page">
      <div className="page-head">
        <h1>Employees</h1>
        <button
          className="btn"
          onClick={() => download('employees.csv', toCsv(['name', 'email', 'department', 'status'], (emps ?? []).map((e) => [e.name, e.email, e.department, e.status ?? 'active'])), 'text/csv')}
          disabled={!emps}
        >
          Export CSV
        </button>
      </div>
      {err && <ErrorBox>{err}</ErrorBox>}
      {canManage && <AddEmployee />}
      {canManage && <ImportEmployees />}
      <div className="toolbar">
        <input type="search" placeholder="Search employees…" title="Search by name, e-mail or department" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search employees" />
        <label className="check small">
          <input type="checkbox" checked={showLeavers} onChange={(e) => setShowLeavers(e.target.checked)} /> Show leavers
        </label>
      </div>
      <Card>
        {shown.length ? (
          <ul className="list">
            {shown.map((e) => (
              <li key={e.id}>
                <span>
                  <strong>{e.name}</strong> {e.status === 'leaver' && <Badge>leaver</Badge>}
                  <div className="small muted">
                    {e.email} · {e.department || '—'} · {devicesOf(e.id).length} device(s)
                  </div>
                </span>
                <span className="btn-row">
                  {canManage && e.status !== 'leaver' && (
                    <button
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => {
                        if (confirm(`Offboard ${e.name}? Their devices will be unassigned and flagged for return.`)) {
                          void run(async () => {
                            const r = await rt.api.offboardEmployee(e.id);
                            return r;
                          }, 'Offboarded — devices unassigned; wipe or retire them from the device page');
                        }
                      }}
                    >
                      Offboard
                    </button>
                  )}
                  {canDsar && <DsarButton emp={e} />}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{q ? 'No employees match.' : 'No employees yet. Add people below, or import your HR list as a CSV file (name, email, department).'}</Empty>
        )}
      </Card>
    </div>
  );
}

function AddEmployee() {
  const rt = useRuntime();
  const [f, setF] = useState({ name: '', email: '', department: '' });
  const { run, busy } = useAction();
  return (
    <Card title="Add employee">
      <form
        className="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await rt.api.createEmployee(f);
            setF({ name: '', email: '', department: '' });
          }, 'Employee added');
        }}
      >
        <Field label="Name">
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={120} />
        </Field>
        <Field label="Work e-mail">
          <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
        </Field>
        <Field label="Department">
          <input value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} maxLength={120} />
        </Field>
        <button className="btn btn-primary" disabled={busy}>
          Add
        </button>
      </form>
    </Card>
  );
}

function ImportEmployees() {
  const rt = useRuntime();
  const input = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<{ created: number; updated: number; errors: { row: number; error: string }[] } | null>(null);
  const { run, busy } = useAction();
  return (
    <Card title="Import from HR (CSV)">
      <p className="small muted">
        Columns: <code>name,email,department</code>. Existing e-mails are updated, new ones created. Max 5000 rows.
      </p>
      <div className="btn-row">
        <input
          ref={input}
          type="file"
          accept=".csv,text/csv"
          aria-label="CSV file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            void run(async () => {
              const rows = csvObjects(await file.text()).map((r) => ({ name: r.name ?? '', email: r.email ?? r['e-mail'] ?? '', department: r.department ?? '' }));
              const r = await rt.api.importEmployees(rows);
              setResult(r);
              if (input.current) input.current.value = '';
              return r;
            }, 'Import finished');
          }}
          disabled={busy}
        />
      </div>
      {result && (
        <p className="small">
          {result.created} created, {result.updated} updated
          {result.errors.length > 0 && (
            <>
              , {result.errors.length} rejected:{' '}
              {result.errors.slice(0, 5).map((e) => `row ${e.row}: ${e.error}`).join('; ')}
            </>
          )}
        </p>
      )}
    </Card>
  );
}

function DsarButton({ emp }: { emp: Employee }) {
  const rt = useRuntime();
  const { run, busy } = useAction();
  return (
    <button
      className="btn btn-sm btn-ghost"
      disabled={busy}
      title="Data-subject access request: export everything held about this person"
      onClick={() => {
        const ticket = prompt(`DSAR ticket reference for ${emp.name} (e.g. DSAR-12):`)?.trim().toUpperCase();
        if (!ticket) return;
        void run(async () => download(`dsar-${emp.email}-${new Date().toISOString().slice(0, 10)}.json`, await rt.api.exportEmployeeData(emp.id, ticket)), 'DSAR export downloaded (recorded in the audit log)');
      }}
    >
      DSAR export
    </button>
  );
}
