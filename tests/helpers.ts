import { Backend, MemoryStore } from '../src/core/backend';
import { SimulatedAgent, newAgentFromProvisioning } from '../src/core/agent';
import { totp } from '../src/core/totp';
import type { Role } from '../src/core/rbac';

export class FakeClock {
  t = Date.UTC(2026, 10, 9, 4, 0, 0); // Monday 09:30 in Colombo (UTC+5:30)
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export const PASSWORD = 'correct horse battery staple';

export async function setup() {
  const clock = new FakeClock();
  const store = new MemoryStore();
  const backend = await Backend.open({ store, clock: clock.now, pbkdf2Iterations: 1000 });
  const accounts: Record<string, { email: string; totpSecret: string }> = {};
  const roles: Role[] = ['SUPER_ADMIN', 'DEVICE_ADMIN', 'HELPDESK', 'LOCATION_OPERATOR', 'SECURITY', 'AUDITOR'];
  for (const role of roles) {
    const a = await backend.createUser({ name: role, email: `${role.toLowerCase()}@corp.test`, role, password: PASSWORD });
    accounts[role] = a;
  }
  // second device admin for four-eyes tests
  accounts.DEVICE_ADMIN_2 = await backend.createUser({ name: 'DA2', email: 'da2@corp.test', role: 'DEVICE_ADMIN', password: PASSWORD });
  const emp = backend.addEmployee({ name: 'Nimal Perera', email: 'nimal@corp.test', department: 'Field Ops' });

  async function signIn(key: string) {
    const acc = accounts[key];
    const { challengeId } = await backend.login(acc.email, PASSWORD);
    const code = await totp(acc.totpSecret, clock.now());
    return (await backend.verifyMfa(challengeId, code)).sessionId;
  }

  async function enrolledAgent(opts: { ack?: boolean } = {}) {
    const admin = await signIn('DEVICE_ADMIN');
    const e = await backend.createEnrollment(admin);
    const agent = new SimulatedAgent(newAgentFromProvisioning(e.provisioning), backend, clock.now);
    await agent.enroll();
    if (opts.ack !== false) agent.acknowledge();
    await agent.checkin();
    return { agent, deviceId: agent.state.deviceId!, admin };
  }

  return { clock, store, backend, accounts, signIn, enrolledAgent, emp };
}
