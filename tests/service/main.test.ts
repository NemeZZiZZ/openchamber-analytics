import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startService, type ServiceRuntime } from '../../src/service/main';
import { createFakeOpenCode, fakeAssistantMessageRaw, fakeSessionRaw, type FakeOpenCode } from '../support/fake-opencode';

const TOKEN = 'main-test-token';

const instances: FakeOpenCode[] = [];
const runtimes: ServiceRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.stop();
  }

  await Promise.all(instances.splice(0).map((instance) => instance.stop()));
});

describe('startService', () => {
  it('exits clearly when required environment values are missing', async () => {
    const base = {
      OPENCHAMBER_SERVICE_TOKEN: TOKEN,
      OPENCHAMBER_OPENCODE_URL: 'http://127.0.0.1:1',
      OPENCHAMBER_SERVICE_DATA_DIR: await mkdtemp(join(tmpdir(), 'analytics-main-')),
      OPENCHAMBER_SERVICE_PORT: '0',
    };

    await expect(startService({})).rejects.toThrow(/OPENCHAMBER_SERVICE_TOKEN/);
    await expect(startService({ ...base, OPENCHAMBER_SERVICE_TOKEN: undefined })).rejects.toThrow(/OPENCHAMBER_SERVICE_TOKEN/);
    await expect(startService({ ...base, OPENCHAMBER_OPENCODE_URL: undefined })).rejects.toThrow(/OPENCHAMBER_OPENCODE_URL/);
    await expect(startService({ ...base, OPENCHAMBER_SERVICE_DATA_DIR: undefined })).rejects.toThrow(/OPENCHAMBER_SERVICE_DATA_DIR/);
    await expect(startService({ ...base, OPENCHAMBER_SERVICE_PORT: undefined })).rejects.toThrow(/OPENCHAMBER_SERVICE_PORT/);

    await rm(base.OPENCHAMBER_SERVICE_DATA_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
  });

  it('starts the authenticated server on loopback and boots the sync engine', async () => {
    const fake = await createFakeOpenCode({
      sessions: [fakeSessionRaw(0, { id: 'ses_main' })],
      messagesBySession: { ses_main: [fakeAssistantMessageRaw('ses_main', 0)] },
    });
    instances.push(fake);

    const dataDir = await mkdtemp(join(tmpdir(), 'analytics-main-'));
    const runtime = await startService({
      OPENCHAMBER_SERVICE_TOKEN: TOKEN,
      OPENCHAMBER_OPENCODE_URL: fake.url,
      OPENCHAMBER_SERVICE_DATA_DIR: dataDir,
      OPENCHAMBER_SERVICE_PORT: '0',
    });
    runtimes.push(runtime);

    const address = runtime.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    expect(port).toBeGreaterThan(0);

    const denied = await fetch(`http://127.0.0.1:${port}/health`);
    expect(denied.status).toBe(401);

    const healthy = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toMatchObject({ ok: true });

    // The engine bootstraps and serves a snapshot from real fake data.
    const snapshot = await fetch(
      `http://127.0.0.1:${port}/v1/snapshot?scope=all&range=all&surface=page&timeZone=UTC`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    expect(snapshot.status).toBe(200);
    const body = (await snapshot.json()) as { summary: { tokens: number }; coverage: { total: number } };
    expect(body.summary.tokens).toBeGreaterThan(0);
    expect(body.coverage.total).toBe(1);

    await runtime.stop();

    // The listener is closed after stop.
    const after = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } }).catch(() => null);
    expect(after).toBeNull();
  });
});
