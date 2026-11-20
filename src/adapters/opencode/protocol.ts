/** Newline-delimited JSON-RPC for one ACP stdio session. Not a package export. */

const maxLineBytes = 1_048_576;

export interface OpenCodeHostChannel {
  listen(sink: { (chunk: Uint8Array): void; ended(): void }): () => void;
  write(frame: Uint8Array, signal: AbortSignal): PromiseLike<void>;
  endInput(): void;
}

export type OpenCodeRpcOutcome =
  | { readonly kind: 'result'; readonly value: unknown }
  | { readonly kind: 'error'; readonly error: { readonly code: number } }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'ended' };

export interface OpenCodeIncomingRequest {
  readonly id: number | string;
  readonly method: string;
  readonly params: unknown;
}

export interface OpenCodeNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface OpenCodeProtocolHandlers {
  onNotification: (message: OpenCodeNotification) => void | 'yield' | Promise<void | 'yield'>;
  onRequest: (message: OpenCodeIncomingRequest) => void | Promise<void>;
  onStopped?: (reason: 'stop' | 'eof' | 'bad-frame') => void;
}

export interface OpenCodeProtocol {
  request(method: string, params: unknown, options: {
    readonly signal: AbortSignal;
    readonly timeoutMs?: number;
    readonly beforeWrite?: () => void;
    readonly onOutcome?: (outcome: OpenCodeRpcOutcome) => void;
  }): Promise<OpenCodeRpcOutcome>;
  notify(method: string, params: unknown): void;
  respond(id: number | string, result: unknown): void;
  respondError(id: number | string, code: number): void;
  start(): void;
  stop(): void;
  releaseReader(): void;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encode(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function isThenable<T>(value: void | T | Promise<T>): value is Promise<T> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && 'then' in value && typeof value.then === 'function';
}

export function openOpenCodeProtocol(channel: OpenCodeHostChannel, handlers: OpenCodeProtocolHandlers): OpenCodeProtocol {
  const output = new AbortController();
  const waiters = new Map<number, (outcome: OpenCodeRpcOutcome) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const queue: Buffer[] = [];
  const deferred: Array<() => void> = [];
  let writeChain: Promise<void> = Promise.resolve();
  let nextId = 1;
  let pending = Buffer.alloc(0);
  let queuedBytes = 0;
  let stopped = false;
  let sawEnd = false;
  let pendingStop = false;
  let flushScheduled = false;
  let pumping = false;
  let started = false;
  let unsubscribe: (() => void) | undefined;

  function flushDeferred(): void {
    const ready = deferred.splice(0);
    for (const deliver of ready) deliver();
  }

  function scheduleFlush(): void {
    if (flushScheduled || deferred.length === 0) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      if (pumping || queue.length > 0) {
        scheduleFlush();
        return;
      }
      flushDeferred();
    });
  }

  function stopAfterDrain(): void {
    if (pumping) {
      pendingStop = true;
      return;
    }
    stop('bad-frame');
  }

  function stop(reason: 'stop' | 'eof' | 'bad-frame' = 'stop'): void {
    if (stopped) return;
    stopped = true;
    output.abort();
    queue.length = 0;
    queuedBytes = 0;
    pending = Buffer.alloc(0);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    const waiting = [...waiters.values()];
    waiters.clear();
    for (const complete of waiting) {
      try { complete({ kind: 'ended' }); } catch { /* the waiter is already resolved */ }
    }
    flushDeferred();
    try { handlers.onStopped?.(reason); } catch { /* the adapter records this itself */ }
  }

  function releaseReader(): void {
    const remove = unsubscribe;
    unsubscribe = undefined;
    try { remove?.(); } catch { /* the sink is already gone */ }
  }

  function enqueueWrite(frame: Uint8Array): Promise<void> {
    const pendingWrite = writeChain.then(() => Promise.resolve(channel.write(frame, output.signal)));
    writeChain = pendingWrite.then(() => undefined, () => undefined);
    return pendingWrite;
  }

  function writeMessage(value: unknown): void {
    if (stopped) return;
    void enqueueWrite(encode(value)).then(() => undefined, () => undefined);
  }

  function request(method: string, params: unknown, options: {
    readonly signal: AbortSignal;
    readonly timeoutMs?: number;
    readonly beforeWrite?: () => void;
    readonly onOutcome?: (outcome: OpenCodeRpcOutcome) => void;
  }): Promise<OpenCodeRpcOutcome> {
    if (stopped || options.signal.aborted) return Promise.resolve({ kind: 'ended' });
    const id = nextId;
    nextId += 1;
    let settled = false;
    let resolve: (outcome: OpenCodeRpcOutcome) => void = () => {};
    const promise = new Promise<OpenCodeRpcOutcome>((done) => { resolve = done; });
    const complete = (outcome: OpenCodeRpcOutcome) => {
      if (settled) return;
      settled = true;
      waiters.delete(id);
      if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(timer);
      }
      options.signal.removeEventListener('abort', onAbort);
      try {
        options.onOutcome?.(outcome);
      } finally {
        const deliver = () => resolve(outcome);
        if (pumping && !stopped) deferred.push(deliver);
        else deliver();
      }
    };
    const onAbort = () => complete({ kind: 'ended' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    waiters.set(id, complete);
    options.signal.addEventListener('abort', onAbort, { once: true });
    try {
      options.beforeWrite?.();
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => complete({ kind: 'timeout' }), options.timeoutMs);
        timers.add(timer);
      }
      const frame = encode({ jsonrpc: '2.0', id, method, params });
      void enqueueWrite(frame).then(() => undefined, () => {
        complete({ kind: 'ended' });
      });
    } catch {
      complete({ kind: 'ended' });
    }
    return promise;
  }

  function notify(method: string, params: unknown): void {
    writeMessage({ jsonrpc: '2.0', method, params });
  }

  function respond(id: number | string, result: unknown): void {
    writeMessage({ jsonrpc: '2.0', id, result });
  }

  function respondError(id: number | string, code: number): void {
    writeMessage({ jsonrpc: '2.0', id, error: { code, message: 'Method not found' } });
  }

  function failLine(): void {
    stop('bad-frame');
  }

  function dispatchLine(line: Buffer): void | 'yield' | Promise<void | 'yield'> {
    const body = line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, -1) : line;
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
    } catch {
      failLine();
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      failLine();
      return;
    }
    if (!record(value) || value.jsonrpc !== '2.0') {
      failLine();
      return;
    }
    const id = typeof value.id === 'number' || typeof value.id === 'string' ? value.id : undefined;
    const method = typeof value.method === 'string' ? value.method : undefined;
    if (id !== undefined && method !== undefined) return handlers.onRequest({ id, method, params: value.params });
    if (method !== undefined && !Object.hasOwn(value, 'id')) return handlers.onNotification({ method, params: value.params });
    if (typeof id === 'number') {
      const complete = waiters.get(id);
      if (!complete) return;
      if (record(value.error)) {
        complete({ kind: 'error', error: { code: typeof value.error.code === 'number' ? value.error.code : 0 } });
        return;
      }
      if (Object.hasOwn(value, 'result')) {
        complete({ kind: 'result', value: value.result });
        return;
      }
      failLine();
      return;
    }
    if (id !== undefined) return;
    failLine();
  }

  function pauseDrain(step: 'yield' | Promise<void | 'yield'>): void {
    void Promise.resolve(step).then((value) => {
      if (stopped) {
        flushDeferred();
        return undefined;
      }
      return value === 'yield' ? Promise.resolve() : undefined;
    }).then(() => {
      if (stopped) flushDeferred();
      else drain();
    }, () => {
      stop('bad-frame');
      pumping = false;
    });
  }

  function drain(): void {
    while (!stopped && queue.length > 0) {
      const line = queue.shift();
      if (line === undefined) break;
      queuedBytes -= line.length;
      let step: void | 'yield' | Promise<void | 'yield'>;
      try {
        step = dispatchLine(line);
      } catch {
        stop('bad-frame');
        pumping = false;
        return;
      }
      if (stopped) break;
      if (step === 'yield' || isThenable(step)) {
        pauseDrain(step);
        return;
      }
    }
    finishDrain();
  }

  function finishDrain(): void {
    pumping = false;
    if (!stopped && queue.length > 0) {
      ensurePump();
      return;
    }
    if (!stopped && pendingStop) {
      pendingStop = false;
      stop('bad-frame');
      return;
    }
    if (sawEnd && !stopped) {
      stop(pending.length > 0 ? 'bad-frame' : 'eof');
      return;
    }
    scheduleFlush();
  }

  function ensurePump(): void {
    if (pumping || stopped) return;
    pumping = true;
    drain();
  }

  function takeLine(line: Buffer): boolean {
    if (line.length === 0 || line.length > maxLineBytes || queuedBytes + line.length > maxLineBytes) return false;
    queuedBytes += line.length;
    queue.push(line);
    return true;
  }

  function accept(chunk: Uint8Array): void {
    try {
      consume(chunk);
    } catch {
      stop('bad-frame');
    }
  }

  function consume(chunk: Uint8Array): void {
    if (stopped) return;
    if (!(chunk instanceof Uint8Array)) {
      stop('bad-frame');
      return;
    }
    let offset = 0;
    while (offset < chunk.length && !stopped) {
      const room = maxLineBytes + 1 - pending.length;
      if (room <= 0) {
        stopAfterDrain();
        return;
      }
      const slice = chunk.subarray(offset, offset + Math.min(room, chunk.length - offset));
      const newlineAt = slice.indexOf(0x0a);
      if (newlineAt === -1 && offset + slice.length < chunk.length) {
        stopAfterDrain();
        return;
      }
      const incoming = newlineAt === -1 ? slice : slice.subarray(0, newlineAt + 1);
      pending = pending.length === 0 ? Buffer.from(incoming) : Buffer.concat([pending, incoming]);
      offset += incoming.length;
      if (newlineAt === -1) break;
      for (;;) {
        const newline = pending.indexOf(0x0a);
        if (newline === -1) break;
        if (newline > maxLineBytes) {
          stopAfterDrain();
          return;
        }
        const line = Buffer.from(pending.subarray(0, newline));
        pending = pending.subarray(newline + 1);
        if (pending.length === 0) pending = Buffer.alloc(0);
        if (!takeLine(line)) {
          ensurePump();
          stopAfterDrain();
          return;
        }
      }
    }
    if (pending.length > maxLineBytes) {
      stopAfterDrain();
      return;
    }
    ensurePump();
  }

  function ended(): void {
    if (stopped) return;
    if (pending.length > 0) {
      stop('bad-frame');
      return;
    }
    sawEnd = true;
    if (!pumping && queue.length > 0) ensurePump();
    if (!stopped && !pumping && queue.length === 0) stop('eof');
  }

  function start(): void {
    if (started) return;
    started = true;
    let detach = () => {};
    unsubscribe = () => { detach(); };
    const sink = Object.assign((chunk: Uint8Array) => accept(chunk), { ended });
    try {
      const remove = channel.listen(sink);
      detach = typeof remove === 'function' ? remove : () => {};
    } catch (error) {
      if (!stopped) {
        stopped = true;
        output.abort();
      }
      try { unsubscribe?.(); } catch { /* the sink is already gone */ }
      throw error;
    }
  }

  return { request, notify, respond, respondError, start, stop, releaseReader };
}
