import { describe, expect, it } from 'vitest';

import { createHostBridge, snapshotRequest } from '../../src/shared/host';
import type { HostClient, HostReadyContext } from '@openchamber/sdk';

function fakeClient(): HostClient & {
  readyListeners: Set<(ctx: HostReadyContext) => void>;
  directoryListeners: Set<(directory: string | null) => void>;
  serviceListeners: Set<(event: { topic: string; data: unknown }) => void>;
} {
  const readyListeners = new Set<(ctx: HostReadyContext) => void>();
  const directoryListeners = new Set<(directory: string | null) => void>();
  const serviceListeners = new Set<(event: { topic: string; data: unknown }) => void>();
  const storageData = new Map<string, unknown>();

  return {
    readyListeners,
    directoryListeners,
    serviceListeners,
    listProjects: async () => ({ projects: [] }) as never,
    listWorktrees: async () => ({}) as never,
    listSessions: async () => ({}) as never,
    onProjects: async () => () => undefined,
    onWorktrees: async () => () => undefined,
    onSessions: async () => () => undefined,
    onRunningShells: async () => () => undefined,
    readShellOutput: async () => ({}) as never,
    stopShell: async () => ({}) as never,
    openSession: async (sessionId: string) => {
      void sessionId;
    },
    storage: {
      get: async (key: string) => storageData.get(key),
      set: async (key: string, value: unknown) => {
        storageData.set(key, value);
      },
      delete: async (key: string) => {
        storageData.delete(key);
      },
      keys: async () => [...storageData.keys()],
    },
    onReady: (listener: (ctx: HostReadyContext) => void) => {
      readyListeners.add(listener);
      return () => readyListeners.delete(listener);
    },
    onDirectory: (listener: (directory: string | null) => void) => {
      directoryListeners.add(listener);
      return () => directoryListeners.delete(listener);
    },
    onSession: () => () => undefined,
    onSessionLifecycle: () => () => undefined,
    onConnection: () => () => undefined,
    onSettings: () => () => undefined,
    onItem: () => () => undefined,
    onBlock: () => () => undefined,
    answerBlock: async () => undefined,
    onServiceEvent: (listener: (event: { topic: string; data: unknown }) => void) => {
      serviceListeners.add(listener);
      return () => serviceListeners.delete(listener);
    },
    onStatusControl: () => () => undefined,
    onPopoverClosed: () => () => undefined,
    setStatusControls: async () => undefined,
    openPopover: async () => undefined,
    closePopover: async () => undefined,
    setPopoverAnchorActive: async () => undefined,
    onResolve: () => () => undefined,
    onAction: () => () => undefined,
    toast: async () => undefined,
    openUrl: async () => undefined,
    openCommit: async () => undefined,
    openSurface: async () => undefined,
    writeClipboard: async () => undefined,
    compose: async () => undefined,
    attach: async () => undefined,
    startSession: async () => ({}) as never,
    prompt: async () => ({}) as never,
    sessionLink: async () => undefined,
    close: async () => undefined,
    oauthStart: async () => undefined,
    oauthDisconnect: async () => undefined,
    request: async () => ({ status: 200, body: '' }),
    serviceRequest: async () => ({ status: 200, body: '{}' }),
    serviceStatus: async () => ({}) as never,
    readFile: async () => ({}) as never,
    writeFile: async () => ({}) as never,
    listDir: async () => ({}) as never,
    stat: async () => ({}) as never,
    generate: async () => ({}) as never,
    onLateGenerateResult: () => () => undefined,
  } as unknown as HostClient & {
    readyListeners: Set<(ctx: HostReadyContext) => void>;
    directoryListeners: Set<(directory: string | null) => void>;
    serviceListeners: Set<(event: { topic: string; data: unknown }) => void>;
  };
}

function readyContext(directory: string | null): HostReadyContext {
  return {
    theme: { mode: 'dark' } as never,
    locale: 'en-US',
    directory,
    session: null,
    surface: 'page',
    connection: { online: true } as never,
    settings: {},
    item: null,
  } as never;
}

describe('createHostBridge', () => {
  it('forwards onReady subscriptions without duplicating registrations', () => {
    const client = fakeClient();
    const bridge = createHostBridge({ client });

    const received: (HostReadyContext | null)[] = [];
    const unsubscribe = bridge.onReady((ctx) => received.push(ctx));

    expect(client.readyListeners.size).toBe(1);

    const ctx = readyContext('/repo/demo');
    for (const listener of client.readyListeners) {
      listener(ctx);
    }

    // A repeated ready snapshot flows through the single listener.
    for (const listener of client.readyListeners) {
      listener(ctx);
    }

    expect(received).toHaveLength(2);

    unsubscribe();
    expect(client.readyListeners.size).toBe(0);
  });

  it('forwards directory events and service events', () => {
    const client = fakeClient();
    const bridge = createHostBridge({ client });

    const directories: (string | null)[] = [];
    const events: { topic: string; data: unknown }[] = [];

    bridge.onDirectory((directory) => directories.push(directory));
    bridge.onServiceEvent((event) => events.push(event));

    for (const listener of client.directoryListeners) {
      listener('/repo/demo');
    }

    for (const listener of client.serviceListeners) {
      listener({ topic: 'analytics:changed', data: { revision: 3 } });
    }

    expect(directories).toEqual(['/repo/demo']);
    expect(events).toEqual([{ topic: 'analytics:changed', data: { revision: 3 } }]);
  });

  it('passes service requests through and exposes storage', async () => {
    let captured: unknown = null;
    const client = fakeClient();

    client.serviceRequest = async (request: unknown) => {
      captured = request;
      return { status: 200, body: '{"ok":true}' };
    };

    const bridge = createHostBridge({ client });
    const result = await bridge.serviceRequest({ method: 'GET', path: '/v1/snapshot', query: { scope: 'all' } });

    expect(result.status).toBe(200);
    expect(result.body).toBe('{"ok":true}');
    expect(captured).toMatchObject({ method: 'GET', path: '/v1/snapshot' });

    await bridge.storage.set('analytics/preferences', { scope: 'all' });
    expect(await bridge.storage.get('analytics/preferences')).toEqual({ scope: 'all' });
  });

  it('builds the snapshot service request with all filter identity parts', () => {
    const request = snapshotRequest({
      scope: 'project',
      directory: '/repo/demo',
      range: '90d',
      surface: 'panel',
      timeZone: 'Europe/Belgrade',
    });

    expect(request.method).toBe('GET');
    expect(request.path).toBe('/v1/snapshot');
    expect(request.query).toEqual({
      scope: 'project',
      directory: '/repo/demo',
      range: '90d',
      surface: 'panel',
      timeZone: 'Europe/Belgrade',
    });
  });
});
