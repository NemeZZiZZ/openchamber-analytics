/**
 * Rolling generation-rate meter (TPS), ported from the MIT-licensed
 * `openchamber-tps` extension (github.com/airtaxi/openchamber-tps) so the
 * analytics panel can replace that plugin.
 *
 * Subscribes to the OpenChamber **global** event stream
 * (`GET <origin>/api/global/event`, the same SSE the UI reads). The global
 * stream is not directory scoped — `/api/event` silently carries only the
 * server's default directory, so an open project would never see its own
 * session events there.
 *
 * The measurement:
 * - Text, reasoning, and tool input all count as generated output; tool call
 *   arguments are billed in `tokens.output`, so they count like the rest.
 * - `session.text.delta` / `session.reasoning.delta` /
 *   `session.tool.input.delta` are the primary source; the full-value
 *   boundaries (`*.ended`) cover parts that sent no fragments and stand in
 *   when the service attached mid-stream. A part is counted by exactly one of
 *   the two paths.
 * - Each settled step (`session.step.ended` / `session.step.failed`) reports
 *   real `tokens.output + tokens.reasoning`; those recalibrate chars-per-token
 *   with a clamped EMA.
 * - The rolling tokens-per-second is `charsPerSecond × charsPerToken` — an
 *   estimate, because the live stream carries characters, not per-character
 *   token counts. Finished-turn averages and session totals use real counts.
 * - A turn spans `session.execution.started` until `succeeded`/`failed`
 *   (`interrupted` with reason `shutdown` keeps it open). Its average divides
 *   tokens by each step's streaming time (first output →
 *   `session.step.streamed`), leaving out time to first token, tool runs,
 *   retries, and waits for the user (`permission.*` / `form.*` / `question.*`).
 */

import type { StreamTimers } from './event-stream';

export type TpsConnectionState = 'idle' | 'connecting' | 'live' | 'error';

/** The finished turn's average rate, shown after the session goes idle. */
export type TpsTurnResult = {
  /** Average tokens per second over the turn's generation time. */
  tokensPerSecond: number;
  /** `tokens` when a settled step reported real counts, otherwise a character estimate. */
  source: 'tokens' | 'estimate';
  tokens: number;
  chars: number;
  /** Time the model spent streaming: each step from its first output to `session.step.streamed`. */
  activeMs: number;
  /** The turn's first output to the end of its last step's stream, pauses included. */
  wallMs: number;
  /** `wallMs − activeMs`: time to first token, tool calls, retries, and waits for the user. */
  pausedMs: number;
  endedAt: number;
};

/** Running session totals from `session.usage.updated`, the only real counters OpenCode 2 publishes live. */
export type TpsSessionUsage = {
  cost: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  /** `output + reasoning`: tokens the model actually generated. */
  generated: number;
};

export type TpsWaiting = 'permission' | 'question' | null;

export type TpsRate = {
  connection: TpsConnectionState;
  error: string | null;
  sessionId: string | null;
  busy: boolean;
  /** Tool input can stream for seconds with no event; an open step is still generating. */
  active: boolean;
  lastEventAt: number | null;
  windowMs: number;
  chars: number;
  charsPerSecond: number;
  tokensPerSecond: number;
  charsPerToken: number;
  sessionUsage: TpsSessionUsage | null;
  lastTurn: TpsTurnResult | null;
  eventsSeen: number;
  lastEventType: string | null;
  waiting: TpsWaiting;
};

export type TpsMeterOptions = {
  fetchImpl?: typeof fetch;
  timers?: StreamTimers;
  now?: () => number;
  windowMs?: number;
  onError?: (message: string) => void;
};

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 15_000;

/** An SSE frame larger than this means the peer is not speaking SSE; drop the stream. */
const FRAME_BUFFER_LIMIT = 1_048_576;

/** No bytes for this long (heartbeats included) means a half-open stream. */
const STREAM_STALL_MS = 60_000;

/** Hard cap on retained delta samples; ~5 seconds of chunks fits far below this. */
const SAMPLE_LIMIT = 20_000;

/** Character-to-token ratios vary by model, language, and content. The default approximates English text. */
const DEFAULT_CHARS_PER_TOKEN = 0.25;
const MIN_CHARS_PER_TOKEN = 0.05;
const MAX_CHARS_PER_TOKEN = 1;
const CALIBRATION_WEIGHT = 0.3;
/** Ignore tiny settled steps when calibrating; they carry no signal. */
const MIN_CALIBRATION_CHARS = 40;
/** A turn whose model output spans less than this has no usable timing. */
const MIN_MEASURABLE_MS = 100;
/** How long after the last output the session still counts as generating. */
const ACTIVE_HOLD_MS = 2_000;

type Sample = { at: number; chars: number };
type PartKind = 'text' | 'reasoning' | 'tool';
type PartPhase = 'started' | 'delta' | 'ended';
type WaitingKind = 'permission' | 'question';
type RawEvent = { type?: unknown; data?: unknown; properties?: unknown };
type WatchConfig = { origin: string; sessionId: string | null };

/**
 * The part events that carry model output. Tool input is generated text too:
 * its tokens are in the step's `tokens.output`, so it counts like the rest.
 */
const PART_EVENTS: Record<string, { kind: PartKind; phase: PartPhase }> = {
  'session.text.started': { kind: 'text', phase: 'started' },
  'session.text.delta': { kind: 'text', phase: 'delta' },
  'session.text.ended': { kind: 'text', phase: 'ended' },
  'session.reasoning.started': { kind: 'reasoning', phase: 'started' },
  'session.reasoning.delta': { kind: 'reasoning', phase: 'delta' },
  'session.reasoning.ended': { kind: 'reasoning', phase: 'ended' },
  'session.tool.input.started': { kind: 'tool', phase: 'started' },
  'session.tool.input.delta': { kind: 'tool', phase: 'delta' },
  'session.tool.input.ended': { kind: 'tool', phase: 'ended' },
};

const readString = (value: unknown): string => (typeof value === 'string' ? value : '');

const readNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

const readRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Hosts the service must never be pointed at: cloud metadata and link-local/unspecified addresses. */
const isForbiddenHost = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    host === '0.0.0.0' ||
    host === '::' ||
    host === 'metadata.google.internal' ||
    /^169\.254\./.test(host) ||
    /^fe[89ab][0-9a-f]:/.test(host)
  );
};

const isHttpOrigin = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username === '' &&
      parsed.password === '' &&
      !isForbiddenHost(parsed.hostname)
    );
  } catch {
    return false;
  }
};

export type TpsMeter = {
  watch(config: { origin: string; sessionId: string | null }): boolean;
  unwatch(): void;
  rate(nowOverride?: number): TpsRate;
  dispose(): void;
};

export function createTpsMeter(options: TpsMeterOptions = {}): TpsMeter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timers = options.timers ?? {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  const now = options.now ?? (() => Date.now());
  const windowMs = options.windowMs ?? 5_000;
  const reportError = options.onError ?? ((message: string) => {
    console.error(`[analytics] TPS stream: ${message}`);
  });

  const samples: Sample[] = [];
  /** Characters seen per part id, used to diff `*.ended` snapshots. */
  const partChars = new Map<string, number>();
  /** Parts already counted through streaming deltas, never diffed again. */
  const deltaParts = new Set<string>();
  /** Characters seen per assistant message id, used to calibrate tokens per character. */
  const messageChars = new Map<string, number>();
  /** Last token total per settled step, so retries settle once. */
  const stepTokens = new Map<string, number>();
  /** Streaming time per step of the turn, keyed by assistant message id. */
  const turnStepMs = new Map<string, number>();
  const pendingPermissions = new Set<string>();
  const pendingQuestions = new Set<string>();

  let watchConfig: WatchConfig | null = null;
  let connection: TpsConnectionState = 'idle';
  let lastError: string | null = null;
  let lastEventAt = 0;
  let eventsSeen = 0;
  let lastEventType: string | null = null;
  let busy = false;
  let charsPerToken = DEFAULT_CHARS_PER_TOKEN;
  let sessionUsage: TpsSessionUsage | null = null;
  let controller: AbortController | null = null;
  let retryTimer: unknown = null;
  let retryDelay = RETRY_BASE_MS;

  // The turn in progress; its spans are described in the module comment.
  let turnOpenedAt: number | null = null;
  let turnClosedAt: number | null = null;
  let turnChars = 0;
  let turnTokens = 0;
  let turnSawTokens = false;
  let lastTurn: TpsTurnResult | null = null;
  let openStep: { messageID: string; openedAt: number; lastOutputAt: number } | null = null;

  const waitingKind = (): WaitingKind | null =>
    pendingPermissions.size > 0 ? 'permission' : pendingQuestions.size > 0 ? 'question' : null;

  const clearTurn = (): void => {
    turnOpenedAt = null;
    turnClosedAt = null;
    turnChars = 0;
    turnTokens = 0;
    turnSawTokens = false;
    turnStepMs.clear();
    openStep = null;
  };

  const resetMeasurement = (): void => {
    samples.length = 0;
    partChars.clear();
    deltaParts.clear();
    messageChars.clear();
    stepTokens.clear();
    lastEventAt = 0;
    busy = false;
    sessionUsage = null;
    clearTurn();
    pendingPermissions.clear();
    pendingQuestions.clear();
    lastTurn = null;
  };

  const closeStep = (at: number): void => {
    if (!openStep) return;
    turnStepMs.set(openStep.messageID, Math.max(0, at - openStep.openedAt));
    turnClosedAt = Math.max(turnClosedAt ?? at, at);
    openStep = null;
  };

  /** Model output for a step: its first output opens the step's generation span. */
  const noteOutput = (messageID: string, at: number): void => {
    if (!messageID) return;
    if (openStep && openStep.messageID !== messageID) closeStep(openStep.lastOutputAt);
    if (!openStep) {
      openStep = { messageID, openedAt: at, lastOutputAt: at };
      turnOpenedAt ??= at;
    }
    openStep.lastOutputAt = at;
  };

  const finalizeTurn = (at: number): void => {
    if (openStep) closeStep(openStep.lastOutputAt);
    let activeMs = 0;
    for (const span of turnStepMs.values()) activeMs += span;
    const source: TpsTurnResult['source'] = turnSawTokens ? 'tokens' : 'estimate';
    const tokens = source === 'tokens' ? turnTokens : turnChars * charsPerToken;

    if (turnOpenedAt === null || turnClosedAt === null || activeMs < MIN_MEASURABLE_MS || tokens <= 0) {
      clearTurn();
      return;
    }

    const wallMs = Math.max(activeMs, turnClosedAt - turnOpenedAt);
    lastTurn = {
      tokensPerSecond: tokens / (activeMs / 1000),
      source,
      tokens,
      chars: turnChars,
      activeMs: Math.round(activeMs),
      wallMs: Math.round(wallMs),
      pausedMs: Math.round(wallMs - activeMs),
      endedAt: at,
    };
    clearTurn();
  };

  const pruneSamples = (at: number): void => {
    let expired = 0;
    while (expired < samples.length && at - samples[expired]!.at > windowMs) {
      expired += 1;
    }
    if (expired > 0) samples.splice(0, expired);
  };

  const recordChars = (messageID: string, partID: string, chars: number, at: number): void => {
    if (chars <= 0) return;
    noteOutput(messageID, at);
    samples.push({ at, chars });
    if (samples.length > SAMPLE_LIMIT) samples.splice(0, samples.length - SAMPLE_LIMIT);
    partChars.set(partID, (partChars.get(partID) ?? 0) + chars);
    messageChars.set(messageID, (messageChars.get(messageID) ?? 0) + chars);
    lastEventAt = at;
    turnChars += chars;
  };

  const isWatchedSession = (sessionID: unknown): boolean =>
    typeof sessionID === 'string' && watchConfig !== null && watchConfig.sessionId !== null && sessionID === watchConfig.sessionId;

  /** Stable part identity: text and reasoning fragments by ordinal, tool input by call id. */
  const partIdOf = (kind: PartKind, messageID: string, payload: Record<string, unknown>): string => {
    if (!messageID) return '';
    if (kind === 'tool') {
      const callID = readString(payload.id);
      return callID ? `${messageID}:tool:${callID}` : '';
    }
    const ordinal = payload.ordinal;
    const index = typeof ordinal === 'number' && Number.isInteger(ordinal) && ordinal >= 0 ? ordinal : 0;
    return `${messageID}:${kind}:${index}`;
  };

  const calibrate = (messageID: string, output: number, reasoning: number): void => {
    const chars = messageChars.get(messageID) ?? 0;
    if (chars < MIN_CALIBRATION_CHARS) return;
    const generated = output + reasoning;
    if (!Number.isFinite(generated) || generated <= 0) return;
    const ratio = Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, generated / chars));
    charsPerToken = charsPerToken + (ratio - charsPerToken) * CALIBRATION_WEIGHT;
  };

  const recordTokens = (messageID: string, output: number, reasoning: number): void => {
    const generated = output + reasoning;
    if (!messageID || generated <= 0) return;
    calibrate(messageID, output, reasoning);
    const previous = stepTokens.get(messageID) ?? 0;
    stepTokens.set(messageID, generated);
    if (turnOpenedAt === null) return;
    turnTokens += generated - previous;
    if (generated > previous) turnSawTokens = true;
  };

  const handleEvent = (event: RawEvent, at: number): void => {
    const type = readString(event.type);
    if (!type) return;
    // OpenCode 2 carries fields in `data`; the 1.x shapes used `properties`.
    const payload = readRecord(event.data) ?? readRecord(event.properties);
    if (!payload) return;

    const part = PART_EVENTS[type];
    if (part) {
      if (!isWatchedSession(payload.sessionID)) return;
      const messageID = readString(payload.assistantMessageID);
      const partID = partIdOf(part.kind, messageID, payload);
      if (!partID) return;

      if (part.phase === 'started') {
        noteOutput(messageID, at);
        lastEventAt = at;
        return;
      }

      if (part.phase === 'delta') {
        const delta = readString(payload.delta);
        if (delta.length === 0) return;
        deltaParts.add(partID);
        recordChars(messageID, partID, delta.length, at);
        return;
      }

      // Full-value boundary: some providers deliver reasoning in one piece and
      // tool input usually arrives only here; also the fallback for a service
      // that attached after the deltas went by.
      noteOutput(messageID, at);
      lastEventAt = at;
      if (deltaParts.has(partID)) return;
      const text = readString(payload.text);
      const previous = partChars.get(partID) ?? 0;
      if (text.length > previous) recordChars(messageID, partID, text.length - previous, at);
      return;
    }

    // The model finished streaming the step; its tools run after this.
    if (type === 'session.step.streamed') {
      if (!isWatchedSession(payload.sessionID)) return;
      if (openStep && openStep.messageID === readString(payload.assistantMessageID)) closeStep(at);
      lastEventAt = at;
      return;
    }

    if (type === 'session.step.ended' || type === 'session.step.failed') {
      if (!isWatchedSession(payload.sessionID)) return;
      const messageID = readString(payload.assistantMessageID);
      if (openStep && openStep.messageID === messageID) closeStep(openStep.lastOutputAt);
      const tokens = readRecord(payload.tokens);
      if (!tokens) return;
      recordTokens(messageID, readNumber(tokens.output), readNumber(tokens.reasoning));
      return;
    }

    if (type === 'session.usage.updated') {
      if (!isWatchedSession(payload.sessionID)) return;
      const tokens = readRecord(payload.tokens);
      if (!tokens) return;
      const cache = readRecord(tokens.cache);
      const output = readNumber(tokens.output);
      const reasoning = readNumber(tokens.reasoning);
      sessionUsage = {
        cost: readNumber(payload.cost),
        input: readNumber(tokens.input),
        output,
        reasoning,
        cacheRead: readNumber(cache?.read),
        cacheWrite: readNumber(cache?.write),
        generated: output + reasoning,
      };
      lastEventAt = at;
      return;
    }

    if (type === 'session.execution.started') {
      if (!isWatchedSession(payload.sessionID)) return;
      busy = true;
      lastEventAt = at;
      return;
    }

    if (type === 'session.execution.succeeded' || type === 'session.execution.failed') {
      if (!isWatchedSession(payload.sessionID)) return;
      busy = false;
      lastEventAt = at;
      finalizeTurn(at);
      return;
    }

    if (type === 'session.execution.interrupted') {
      if (!isWatchedSession(payload.sessionID)) return;
      lastEventAt = at;
      // A shutdown is not the end of the turn: OpenCode resumes it after restart.
      if (readString(payload.reason) === 'shutdown') return;
      busy = false;
      finalizeTurn(at);
      return;
    }

    if (type === 'permission.asked' || type === 'permission.v2.asked') {
      if (!isWatchedSession(payload.sessionID)) return;
      const requestId = readString(payload.id);
      if (requestId) pendingPermissions.add(requestId);
      lastEventAt = at;
      return;
    }

    if (type === 'permission.replied' || type === 'permission.v2.replied') {
      if (!isWatchedSession(payload.sessionID)) return;
      const requestId = readString(payload.requestID);
      if (requestId) pendingPermissions.delete(requestId);
      lastEventAt = at;
      return;
    }

    // OpenCode 2 models the question tool as a form.
    if (type === 'form.created') {
      const form = readRecord(payload.form);
      if (!form || !isWatchedSession(form.sessionID)) return;
      const requestId = readString(form.id);
      if (requestId) pendingQuestions.add(requestId);
      lastEventAt = at;
      return;
    }

    if (type === 'form.replied' || type === 'form.cancelled') {
      if (!isWatchedSession(payload.sessionID)) return;
      const requestId = readString(payload.id);
      if (requestId) pendingQuestions.delete(requestId);
      lastEventAt = at;
      return;
    }

    if (type === 'question.asked' || type === 'question.v2.asked') {
      if (!isWatchedSession(payload.sessionID)) return;
      const requestId = readString(payload.id);
      if (requestId) pendingQuestions.add(requestId);
      lastEventAt = at;
      return;
    }

    if (
      type === 'question.replied' ||
      type === 'question.rejected' ||
      type === 'question.v2.replied' ||
      type === 'question.v2.rejected'
    ) {
      if (!isWatchedSession(payload.sessionID)) return;
      const requestId = readString(payload.requestID);
      if (requestId) pendingQuestions.delete(requestId);
      lastEventAt = at;
      return;
    }

    if (type === 'session.status') {
      if (!isWatchedSession(payload.sessionID)) return;
      const status = readRecord(payload.status);
      const nextBusy = status?.type === 'busy' || status?.type === 'retry';
      if (busy && !nextBusy) finalizeTurn(at);
      busy = nextBusy;
      lastEventAt = at;
      return;
    }

    if (type === 'session.idle') {
      if (!isWatchedSession(payload.sessionID)) return;
      busy = false;
      lastEventAt = at;
      finalizeTurn(at);
    }
  };

  /** Parses one SSE frame (`data:` lines) and dispatches the event. */
  const consumeChunk = (chunk: string): void => {
    const data: string[] = [];
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data:')) continue;
      data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.join('\n'));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    // OpenCode 2 frames are the event itself; a proxy that wraps them as
    // `{ payload, directory, eventId }` is unwrapped here.
    const envelope = parsed as { payload?: unknown };
    const event = (envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : parsed) as RawEvent;
    eventsSeen += 1;
    lastEventType = readString(event.type) || null;
    handleEvent(event, now());
  };

  const scheduleReconnect = (message: string): void => {
    if (!watchConfig || watchConfig.sessionId === null) {
      // Nothing to reconnect for: keep the reported state coherent.
      return;
    }

    lastError = message;
    connection = 'error';
    reportError(message);
    if (retryTimer !== null) return;
    const delay = retryDelay;
    retryDelay = Math.min(RETRY_MAX_MS, retryDelay * 2);
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      startStream();
    }, delay);
  };

  const startStream = async (): Promise<void> => {
    const current = watchConfig;
    if (!current) return;
    if (retryTimer !== null) {
      timers.clearTimeout(retryTimer);
      retryTimer = null;
    }
    controller?.abort();
    const local = new AbortController();
    controller = local;
    connection = 'connecting';
    lastError = null;

    try {
      const response = await fetchImpl(new URL('/api/global/event', current.origin), {
        headers: { Accept: 'text/event-stream' },
        signal: local.signal,
      });

      if (!response.ok || !response.body) {
        scheduleReconnect(`Event stream answered HTTP ${response.status}`);
        return;
      }

      connection = 'live';
      retryDelay = RETRY_BASE_MS;
      lastEventAt = now();
      eventsSeen = 0;
      lastEventType = null;

      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      let buffer = '';
      let stalled = false;
      let stallTimer: unknown = null;
      const armWatchdog = (): void => {
        if (stallTimer !== null) timers.clearTimeout(stallTimer);
        stallTimer = timers.setTimeout(() => {
          stalled = true;
          local.abort();
        }, STREAM_STALL_MS);
      };

      armWatchdog();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          armWatchdog();
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const chunk = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            consumeChunk(chunk);
            boundary = buffer.indexOf('\n\n');
          }
          if (buffer.length > FRAME_BUFFER_LIMIT) {
            local.abort();
            scheduleReconnect('Event stream frame exceeded the buffer limit');
            return;
          }
          if (local.signal.aborted) return;
        }
      } catch (error) {
        if (stalled && controller === local) {
          scheduleReconnect('Event stream stalled');
          return;
        }
        throw error;
      } finally {
        if (stallTimer !== null) timers.clearTimeout(stallTimer);
      }

      if (!local.signal.aborted) scheduleReconnect('Event stream closed');
    } catch (error) {
      if (local.signal.aborted) return;
      scheduleReconnect(error instanceof Error ? error.message : String(error));
    }
  };

  const stopStream = (): void => {
    if (retryTimer !== null) {
      timers.clearTimeout(retryTimer);
      retryTimer = null;
    }
    controller?.abort();
    controller = null;
    connection = 'idle';
  };

  return {
    watch(config) {
      if (!isHttpOrigin(config.origin)) {
        throw new Error('origin must be an http(s) origin from the OpenChamber server');
      }

      const changed =
        watchConfig === null || watchConfig.origin !== config.origin || watchConfig.sessionId !== config.sessionId;
      if (!changed) return false;
      watchConfig = { origin: config.origin, sessionId: config.sessionId };
      resetMeasurement();

      // A null session means no open chat: never hold an SSE connection for it.
      if (config.sessionId === null) {
        stopStream();
        return changed;
      }

      retryDelay = RETRY_BASE_MS;
      stopStream();
      void startStream();
      return changed;
    },

    unwatch() {
      watchConfig = null;
      resetMeasurement();
      stopStream();
    },

    rate(nowOverride) {
      const at = nowOverride ?? now();
      pruneSamples(at);
      let chars = 0;
      for (const sample of samples) chars += sample.chars;
      const charsPerSecond = chars / (windowMs / 1000);

      return {
        connection,
        error: lastError,
        sessionId: watchConfig?.sessionId ?? null,
        busy,
        active: openStep !== null || (lastEventAt > 0 && at - lastEventAt < ACTIVE_HOLD_MS),
        lastEventAt: lastEventAt || null,
        windowMs,
        chars,
        charsPerSecond,
        tokensPerSecond: charsPerSecond * charsPerToken,
        charsPerToken,
        sessionUsage,
        lastTurn,
        eventsSeen,
        lastEventType,
        waiting: waitingKind(),
      };
    },

    dispose() {
      stopStream();
      resetMeasurement();
      watchConfig = null;
    },
  };
}
