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
  let stopped = false;
  let pumping = false;
  let started = false;

  function flushDeferred(): void {
    const ready = deferred.splice(0);
    for (const deliver of ready) deliver();
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    output.abort();
    queue.length = 0;
    pending = Buffer.alloc(0);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    const waiting = [...waiters.values()];
    waiters.clear();
    for (const complete of waiting) complete({ kind: 'ended' });
    flushDeferred();
  }

  function enqueueWrite(frame: Uint8Array): Promise<void> {
    const pendingWrite = writeChain.then(() => {
      if (stopped) return undefined;
      return Promise.resolve(channel.write(frame, output.signal));
    });
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
      options.onOutcome?.(outcome);
      const deliver = () => resolve(outcome);
      if (pumping && !stopped) deferred.push(deliver);
      else deliver();
    };
    const onAbort = () => complete({ kind: 'ended' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => complete({ kind: 'timeout' }), options.timeoutMs);
      timers.add(timer);
    }
    waiters.set(id, complete);
    options.signal.addEventListener('abort', onAbort, { once: true });
    options.beforeWrite?.();
    let frame: Uint8Array;
    try {
      frame = encode({ jsonrpc: '2.0', id, method, params });
    } catch {
      complete({ kind: 'ended' });
      return promise;
    }
    void enqueueWrite(frame).then(() => undefined, () => {
      complete({ kind: 'ended' });
    });
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
    stop();
  }

  function dispatchLine(line: Buffer): void | 'yield' | Promise<void | 'yield'> {
    const text = line.toString('utf8');
    let value: unknown;
    try {
      value = JSON.parse(text.endsWith('\r') ? text.slice(0, -1) : text);
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
    if (id !== undefined && method !== undefined) {
      const incoming = handlers.onRequest({ id, method, params: value.params });
      if (isThenable(incoming)) void Promise.resolve(incoming).then(() => undefined, () => { stop(); });
      return;
    }
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
      stop();
      pumping = false;
    });
  }

  function drain(): void {
    while (!stopped && queue.length > 0) {
      const line = queue.shift();
      if (line === undefined) break;
      let step: void | 'yield' | Promise<void | 'yield'>;
      try {
        step = dispatchLine(line);
      } catch {
        stop();
        pumping = false;
        return;
      }
      if (stopped) break;
      if (step === 'yield' || isThenable(step)) {
        pauseDrain(step);
        return;
      }
    }
    flushDeferred();
    pumping = false;
    if (!stopped && queue.length > 0) ensurePump();
  }

  function ensurePump(): void {
    if (pumping || stopped) return;
    pumping = true;
    drain();
  }

  function accept(chunk: Uint8Array): void {
    if (stopped) return;
    if (!(chunk instanceof Uint8Array)) {
      stop();
      return;
    }
    pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
    for (;;) {
      const newline = pending.indexOf(0x0a);
      if (newline === -1) break;
      if (newline > maxLineBytes) {
        stop();
        return;
      }
      queue.push(Buffer.from(pending.subarray(0, newline)));
      pending = pending.subarray(newline + 1);
    }
    if (pending.length > maxLineBytes) {
      stop();
      return;
    }
    ensurePump();
  }

  function ended(): void {
    stop();
  }

  function start(): void {
    if (started) return;
    started = true;
    const sink = Object.assign((chunk: Uint8Array) => accept(chunk), { ended });
    channel.listen(sink);
  }

  return { request, notify, respond, respondError, start, stop };
}
