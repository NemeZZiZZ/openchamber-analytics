import { connectHost, type HostClient, type HostReadyContext } from '@openchamber/sdk';
import type { JsonValue } from '@openchamber/sdk';

import type { AnalyticsFilters } from './analytics-types';

export type { HostReadyContext };

export type ServiceRequest = {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string>;
  body?: string;
};

export type ServiceResponse = {
  status: number;
  body: string;
};

/**
 * The slice of the public host client the analytics surfaces rely on, wrapped
 * behind an injectable interface so controller logic is testable without a
 * live host frame.
 */
export type HostBridge = {
  onReady(listener: (context: HostReadyContext) => void): () => void;
  onDirectory(listener: (directory: string | null) => void): () => void;
  onServiceEvent(listener: (event: { topic: string; data: unknown }) => void): () => void;
  serviceRequest(request: ServiceRequest): Promise<ServiceResponse>;
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  openSession(sessionId: string): Promise<void>;
};

export type HostBridgeOptions = {
  /** Injectable host client; defaults to the real public connectHost(). */
  client?: HostClient;
};

/** Builds the authenticated service request for one snapshot query. */
export function snapshotRequest(filters: AnalyticsFilters): ServiceRequest {
  const query: Record<string, string> = {
    scope: filters.scope,
    range: filters.range,
    surface: filters.surface,
    timeZone: filters.timeZone,
  };

  if (filters.directory !== undefined) {
    query.directory = filters.directory;
  }

  return { method: 'GET', path: '/v1/snapshot', query };
}

export function createHostBridge(options: HostBridgeOptions = {}): HostBridge {
  const client = options.client ?? connectHost();

  return {
    onReady: (listener) => client.onReady(listener),
    onDirectory: (listener) => client.onDirectory(listener),
    onServiceEvent: (listener) => client.onServiceEvent((event) => listener({ topic: event.topic, data: event.data })),

    async serviceRequest(request): Promise<ServiceResponse> {
      const result = await client.serviceRequest({
        method: request.method,
        path: request.path,
        query: request.query,
        body: request.body,
      });

      return { status: result.status, body: result.body };
    },

    storage: {
      async get(key) {
        return client.storage.get(key);
      },
      async set(key, value) {
        await client.storage.set(key, value as JsonValue);
      },
    },

    async openSession(sessionId) {
      await client.openSession(sessionId);
    },
  };
}
