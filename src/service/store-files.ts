import { mkdir, readFile, rename, writeFile, appendFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import type { CounterEvent } from '../shared/analytics-types';

export const MANIFEST_SCHEMA_VERSION = 2;

/** Version 1 data (no counters file, no session outcome fields) still loads. */
const SUPPORTED_SCHEMA_VERSIONS = [1, MANIFEST_SCHEMA_VERSION];

export type StoreManifest = {
  schemaVersion: number;
  revision: number;
  generation: number;
  lastReconciliation?: number;
};

/** sessions.jsonl line: session metadata + sync state. */
export type SessionLine = {
  sessionId: string;
  session: unknown;
  fingerprint: string;
  state: string;
  attempts: number;
  lastError?: string;
  syncedAt?: number;
};

/** events.jsonl line: one allocation checkpoint. */
export type AllocationLine = {
  sessionId: string;
  fingerprint: string;
  state: string;
  events: unknown[];
  attempts: number;
  lastError?: string;
  syncedAt?: number;
};

/** counters.jsonl line: one counted stream occurrence. */
export type CounterLine = CounterEvent;

export const SESSIONS_FILE = 'sessions.jsonl';
export const EVENTS_FILE = 'events.jsonl';
export const COUNTERS_FILE = 'counters.jsonl';
export const MANIFEST_FILE = 'manifest.json';

export function sessionsPath(dataDir: string): string {
  return join(dataDir, SESSIONS_FILE);
}

export function eventsPath(dataDir: string): string {
  return join(dataDir, EVENTS_FILE);
}

export function countersPath(dataDir: string): string {
  return join(dataDir, COUNTERS_FILE);
}

export function manifestPath(dataDir: string): string {
  return join(dataDir, MANIFEST_FILE);
}

export async function ensureDataDir(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
}

/**
 * Migrate permissive directories and files created by earlier releases.
 * Missing files are expected on a fresh install; other failures must surface.
 */
export async function enforcePrivatePermissions(dataDir: string): Promise<void> {
  await chmod(dataDir, 0o700);

  for (const file of [MANIFEST_FILE, SESSIONS_FILE, EVENTS_FILE, COUNTERS_FILE]) {
    try {
      await chmod(join(dataDir, file), PRIVATE_FILE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

/** Session titles and directories are private: owner read/write only. */
const PRIVATE_FILE_MODE = 0o600;

let atomicWriteCounter = 0;

/** Atomic temp-file + rename write with a unique temp name per call. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.${Date.now()}.${atomicWriteCounter++}.tmp`;
  await writeFile(temp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  await rename(temp, path);
}

export async function readManifest(dataDir: string): Promise<StoreManifest | null> {
  let raw: string;

  try {
    raw = await readFile(manifestPath(dataDir), 'utf8');
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoreManifest>;

    if (!SUPPORTED_SCHEMA_VERSIONS.includes(parsed.schemaVersion as number) || typeof parsed.revision !== 'number') {
      return null;
    }

    return {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      revision: Math.max(0, Math.floor(parsed.revision)),
      generation: Math.max(1, Math.floor(parsed.generation ?? 1)),
      lastReconciliation: typeof parsed.lastReconciliation === 'number' ? parsed.lastReconciliation : undefined,
    };
  } catch {
    return null;
  }
}

export async function writeManifest(dataDir: string, manifest: StoreManifest): Promise<void> {
  await writeJsonAtomic(manifestPath(dataDir), manifest);
}

/**
 * Reads a JSONL file, returning every complete parsed line. Malformed lines
 * are skipped: a truncated final write (crash mid-append) loses only that
 * record, which duplicate-resolution and re-appends recover.
 */
export async function readJsonLines<T>(path: string): Promise<T[]> {
  let raw: string;

  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }

  const lines: T[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();

    if (trimmed === '') {
      continue;
    }

    try {
      lines.push(JSON.parse(trimmed) as T);
    } catch {
      // Truncated or corrupt line: skip it, keep the rest.
    }
  }

  return lines;
}

/**
 * A crash mid-append can leave a final line without its newline; the next
 * append would then fuse a good record into the corrupt one. Terminating the
 * dangling line keeps the garbage isolated (it is skipped on read).
 */
export async function repairTrailingNewline(path: string): Promise<void> {
  let raw: string;

  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return;
  }

  if (raw !== '' && !raw.endsWith('\n')) {
    await appendFile(path, '\n', { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  }
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await appendFile(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
}

/** Atomic generation swap: rewrite canonical files from live state. */
export async function compactFiles(
  dataDir: string,
  sessions: SessionLine[],
  allocations: AllocationLine[],
  manifest: StoreManifest,
  counters: CounterLine[] = [],
): Promise<void> {
  const sessionText = sessions.map((line) => JSON.stringify(line)).join('\n');
  const eventText = allocations.map((line) => JSON.stringify(line)).join('\n');
  const counterText = counters.map((line) => JSON.stringify(line)).join('\n');

  await writeFile(join(dataDir, `${SESSIONS_FILE}.tmp`), sessionText === '' ? '' : `${sessionText}\n`, {
    encoding: 'utf8',
    mode: PRIVATE_FILE_MODE,
  });
  await writeFile(join(dataDir, `${EVENTS_FILE}.tmp`), eventText === '' ? '' : `${eventText}\n`, {
    encoding: 'utf8',
    mode: PRIVATE_FILE_MODE,
  });
  await writeFile(join(dataDir, `${COUNTERS_FILE}.tmp`), counterText === '' ? '' : `${counterText}\n`, {
    encoding: 'utf8',
    mode: PRIVATE_FILE_MODE,
  });
  await writeJsonAtomic(join(dataDir, `${MANIFEST_FILE}.tmp`), manifest);

  await rename(join(dataDir, `${SESSIONS_FILE}.tmp`), sessionsPath(dataDir));
  await rename(join(dataDir, `${EVENTS_FILE}.tmp`), eventsPath(dataDir));
  await rename(join(dataDir, `${COUNTERS_FILE}.tmp`), countersPath(dataDir));
  await rename(join(dataDir, `${MANIFEST_FILE}.tmp`), manifestPath(dataDir));
}
