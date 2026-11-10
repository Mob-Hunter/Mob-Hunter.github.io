import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { SimulatedAgent, newAgentFromProvisioning } from '../src/core/agent';
import { sanitiseInventory, unsupportedReason, BULK_COMMANDS } from '../src/core/backend';
import { can } from '../src/core/rbac';

describe('device inventory', () => {
  it('a computer uploads its inventory; admins read it per device and search software across the fleet', async () => {
    const { backend, signIn } = await setup();
    const admin = await signIn('DEVICE_ADMIN');
    const e = await backend.createEnrollment(admin);
    const pc = new SimulatedAgent(newAgentFromProvisioning(e.provisioning, { platform: 'windows', hardware: { serial: 'PF4K2Z9', model: 'Dell Latitude 7450', os: 'Windows 11 Pro' } }), backend);
    await pc.enroll();
    pc.acknowledge();
    await pc.checkin();
    expect(backend.getInventory(admin, pc.state.deviceId!)).toBeNull();
    await pc.sendInventory();
    const inv = backend.getInventory(admin, pc.state.deviceId!)!;
    expect(inv.data.system.serial).toBe('PF4K2Z9');
    expect(inv.data.software.map((s) => s.name)).toContain('Google Chrome');
    expect(inv.data.settings.find((s) => s.name === 'User Account Control')?.value).toBe('On');
    // DeviceView carries only the timestamp; the inventory is fetched separately.
    const view = backend.getDevice(admin, pc.state.deviceId!);
    expect(view.inventoryAt).toBe(inv.receivedAt);
    expect('inventory' in view).toBe(false);
    // Fleet software search, read-only roles included.
    const auditor = await signIn('AUDITOR');
    const rows = backend.listSoftware(auditor, 'chrome');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Google Chrome', deviceCount: 1, versions: [{ version: '131.0.6778.86', devices: [{ id: pc.state.deviceId, platform: 'windows' }] }] });
  });

  it('COLLECT_INVENTORY is a signed command phones and computers run; allowed in bulk; not for Location Operators', async () => {
    const { backend, enrolledAgent, signIn } = await setup();
    const { agent, deviceId, admin } = await enrolledAgent();
    await backend.issueCommand(admin, deviceId, { type: 'COLLECT_INVENTORY' });
    await agent.poll();
    expect(backend.getInventory(admin, deviceId)?.data.os.name).toBe('Android 16');
    expect(backend.listCommands(admin, deviceId).find((c) => c.type === 'COLLECT_INVENTORY')?.status).toBe('succeeded');
    expect(BULK_COMMANDS.has('COLLECT_INVENTORY')).toBe(true);
    expect(unsupportedReason({ platform: 'linux', managementMode: 'standard', capabilities: null }, 'COLLECT_INVENTORY')).toBeNull();
    expect(unsupportedReason({ platform: 'android', managementMode: 'standard', capabilities: null }, 'COLLECT_INVENTORY')).toBeNull();
    expect(can('HELPDESK', 'command.COLLECT_INVENTORY')).toBe(true);
    expect(can('LOCATION_OPERATOR', 'command.COLLECT_INVENTORY')).toBe(false);
    await expect(backend.issueCommand(await signIn('LOCATION_OPERATOR'), deviceId, { type: 'COLLECT_INVENTORY' })).rejects.toMatchObject({ status: 403 });
  });

  it('keeps only known, bounded fields from what an agent sends', () => {
    const big = sanitiseInventory({
      collectedAt: 1,
      agentVersion: '2.0.0',
      system: { hostname: 'PC-1', evil: '<script>', serial: 'x'.repeat(500) },
      os: { name: 'Windows 11', arch: 'amd64' },
      hardware: { cores: 8, memoryGb: 31.94, cpu: { nested: true } },
      disks: [{ mount: 'C:', sizeGb: 476.3, freeGb: 100, encrypted: true }],
      network: [{ name: 'Wi-Fi', mac: 'aa:bb', ipv4: ['10.0.0.2', 5], up: true }],
      settings: [{ category: 'Security', name: 'UAC', value: 'On\u0000' }, { name: '' }],
      software: Array.from({ length: 4000 }, (_, i) => ({ name: `App ${i}`, version: '1.0' })),
      files: ['secret.docx'],
    });
    expect((big.system as Record<string, unknown>).evil).toBeUndefined();
    expect(big.system.serial).toHaveLength(120);
    expect(big.hardware).toEqual({ cores: 8, memoryGb: 31.9 });
    expect(big.network[0].ipv4).toEqual(['10.0.0.2']);
    expect(big.settings).toEqual([{ category: 'Security', name: 'UAC', value: 'On' }]);
    expect(big.software).toHaveLength(3000);
    expect('files' in big).toBe(false);
    expect(() => sanitiseInventory({ software: [{ name: 'x'.repeat(1_000_000) }] })).toThrow(/too large/);
  });
});
