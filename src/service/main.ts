import { createServiceHost } from '@openchamber/sdk';
import type { Server } from 'node:http';

import { createAnalyticsServer } from './routes';
import { createOpenCodeReader } from './opencode';
import { openAnalyticsStore } from './store';
import { createSyncEngine, type SyncEngine } from './sync';
import { createServiceEvents, type ServiceEvents } from './service-events';
import { createTpsMeter, type TpsMeter } from './tps';

export type ServiceRuntime = {
  server: Server;
  engine: SyncEngine;
  serviceEvents: ServiceEvents;
  tps: TpsMeter;
  stop(): Promise<void>;
};

export type ServiceEnv = Record<string, string | undefined>;

const REQUIRED_ENV = [
  'OPENCHAMBER_SERVICE_TOKEN',
  'OPENCHAMBER_OPENCODE_URL',
  'OPENCHAMBER_SERVICE_DATA_DIR',
  'OPENCHAMBER_SERVICE_PORT',
] as const;

function assertEnvironment(env: ServiceEnv): void {
  const missing = REQUIRED_ENV.filter((key) => !env[key] || (env[key] ?? '').trim() === '');

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment: ${missing.join(', ')}. The analytics service must be started by OpenChamber with service grants.`,
    );
  }
}

/**
 * Runtime entry for the OpenChamber host service. Reads only the documented
 * service environment values, boots the durable store, the bounded sync
 * engine, and the authenticated loopback HTTP API, and never exposes the
 * OpenCode URL or service token beyond this process boundary.
 */
export async function startService(env: ServiceEnv): Promise<ServiceRuntime> {
  assertEnvironment(env);

  const token = env.OPENCHAMBER_SERVICE_TOKEN!;
  const port = Number(env.OPENCHAMBER_SERVICE_PORT);

  if (!Number.isFinite(port) || port < 0 || port > 65_535) {
    throw new Error('OPENCHAMBER_SERVICE_PORT must be a valid port number.');
  }

  const store = await openAnalyticsStore(env.OPENCHAMBER_SERVICE_DATA_DIR!);
  const reader = createOpenCodeReader({
    baseUrl: env.OPENCHAMBER_OPENCODE_URL!,
    token,
  });

  const engine = createSyncEngine({ reader, store });
  const tps: TpsMeter = createTpsMeter();
  const serviceEvents = createServiceEvents({
    host: createServiceHost({ env }),
  });

  // routes.ts wires engine revisions into serviceEvents.
  const server = createAnalyticsServer({ store, engine, token, port, serviceEvents, tps });

  const logUnhandled = (reason: unknown): void => {
    console.error(`[analytics] unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  };
  process.on('unhandledRejection', logUnhandled);

  await engine.start();

  const shutdown = (): Promise<void> => stop();

  async function stop(): Promise<void> {
    process.off('SIGTERM', shutdown);
    process.off('SIGINT', shutdown);
    process.off('unhandledRejection', logUnhandled);
    await engine.stop();
    await serviceEvents.stop();
    tps.dispose();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
      // Streaming clients must not keep shutdown hanging.
      setTimeout(() => server.closeAllConnections(), 2_000).unref();
    });
    await store.close();
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return { server, engine, serviceEvents, tps, stop };
}

const isDirectRun = process.argv[1]?.endsWith('main.js') ?? false;

if (isDirectRun) {
  startService(process.env).catch((error: unknown) => {
    console.error(`[analytics] service failed to start: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
