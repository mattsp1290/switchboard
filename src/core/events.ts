import type { Outcome } from './contracts.js';

export type SubscriptionEnd = 'disposed' | 'aborted' | 'overflow' | 'listener-error' | 'closed';

export interface Subscription {
  readonly dispose: () => void;
  /** Resolves on detachment, even when consumer code has not stopped. */
  readonly ended: Promise<SubscriptionEnd>;
}

export type EventListener<T> = (event: T, deliverySignal: AbortSignal) => void | PromiseLike<void>;
export type SubscribeError = { readonly code: 'closed' | 'capacity' };
export type PublishResult =
  | { readonly kind: 'published'; readonly enqueued: number; readonly disconnected: number }
  | { readonly kind: 'closed' };

/** Observation can be handed to consumers without granting publication rights. */
export interface EventObserver<T> {
  readonly subscribe: (
    listener: EventListener<T>,
    options?: { readonly signal?: AbortSignal },
  ) => Outcome<Subscription, SubscribeError>;
}

export interface EventStream<T> extends EventObserver<T> {
  readonly publish: (event: T) => PublishResult;
  /** Immediate teardown drops queued events. It never cancels native work. */
  readonly close: () => void;
}

export interface EventStreamBounds {
  /** Positive safe integer. Includes retired observers with unsettled callbacks. */
  readonly maxObservers: number;
  /** Positive safe integer. Counts queued events plus the active callback. */
  readonly capacity: number;
}

type ObserverState<T> =
  | { readonly kind: 'open'; readonly queue: { readonly value: T }[]; readonly listener: EventListener<T> }
  | { readonly kind: 'ended' };

interface Observer<T> {
  state: ObserverState<T>;
  draining: boolean;
  readonly delivery: AbortController;
  readonly detachAbort: () => void;
  readonly settle: (reason: SubscriptionEnd) => void;
}

/**
 * Independent asynchronous FIFO delivery with disconnect on overflow. Publish
 * never waits for listeners. Bounds and their product must be safe integers;
 * invalid bounds throw RangeError. Payload byte size and synchronous listener
 * execution time are caller responsibilities. Payloads are passed by reference.
 *
 * An already-aborted subscription ends immediately without taking a lease, unless
 * the stream is closed. Other terminal paths clear queues and abort delivery,
 * but retain leases until scheduled drains and active callbacks settle. A hung
 * callback can therefore exhaust admission without delaying close or disposal.
 * There is no replay or native-operation cancellation.
 */
export function createEventStream<T>(bounds: EventStreamBounds): EventStream<T> {
  const { maxObservers, capacity } = bounds;
  if (!Number.isSafeInteger(maxObservers) || maxObservers <= 0
    || !Number.isSafeInteger(capacity) || capacity <= 0
    || !Number.isSafeInteger(maxObservers * capacity)) {
    throw new RangeError('Event bounds and their product must be positive safe integers.');
  }
  const leases = new Set<Observer<T>>();
  let closed = false;

  function retire(observer: Observer<T>, reason: SubscriptionEnd): AbortController | undefined {
    if (observer.state.kind === 'ended') return;
    observer.state.queue.length = 0;
    observer.state = { kind: 'ended' };
    observer.detachAbort();
    observer.settle(reason);
    if (!observer.draining) leases.delete(observer);
    return observer.delivery;
  }

  function end(observer: Observer<T>, reason: SubscriptionEnd): void {
    retire(observer, reason)?.abort();
  }

  async function drain(observer: Observer<T>): Promise<void> {
    try {
      while (observer.state.kind === 'open') {
        const next = observer.state.queue[0];
        if (!next) break;
        await observer.state.listener(next.value, observer.delivery.signal);
        if (observer.state.kind === 'open') observer.state.queue.shift();
      }
    } catch {
      end(observer, 'listener-error');
    } finally {
      observer.draining = false;
      if (observer.state.kind === 'ended') leases.delete(observer);
    }
  }

  function subscribe(
    listener: EventListener<T>,
    options?: { readonly signal?: AbortSignal },
  ): Outcome<Subscription, SubscribeError> {
    if (closed) return { kind: 'error', error: { code: 'closed' } };
    const signal = options?.signal;
    if (signal?.aborted) {
      return { kind: 'ok', value: { dispose() {}, ended: Promise.resolve('aborted') } };
    }
    if (leases.size >= maxObservers) return { kind: 'error', error: { code: 'capacity' } };
    let observer: Observer<T>;
    const abort = () => end(observer, 'aborted');
    const ended = new Promise<SubscriptionEnd>((settle) => {
      observer = {
        state: { kind: 'open', queue: [], listener },
        draining: false,
        delivery: new AbortController(),
        detachAbort: () => signal?.removeEventListener('abort', abort),
        settle,
      };
      leases.add(observer);
    });
    signal?.addEventListener('abort', abort, { once: true });
    return { kind: 'ok', value: { dispose: () => end(observer, 'disposed'), ended } };
  }

  function publish(event: T): PublishResult {
    if (closed) return { kind: 'closed' };
    let enqueued = 0;
    const disconnected: AbortController[] = [];
    for (const observer of leases) {
      if (observer.state.kind === 'ended') continue;
      if (observer.state.queue.length === capacity) {
        const delivery = retire(observer, 'overflow');
        if (delivery) disconnected.push(delivery);
        continue;
      }
      observer.state.queue.push({ value: event });
      enqueued++;
      if (!observer.draining) {
        observer.draining = true;
        queueMicrotask(() => { void drain(observer); });
      }
    }
    // Abort handlers can publish reentrantly. Admit this event everywhere first.
    for (const delivery of disconnected) delivery.abort();
    return { kind: 'published', enqueued, disconnected: disconnected.length };
  }

  function close(): void {
    if (closed) return;
    closed = true;
    const deliveries: AbortController[] = [];
    for (const observer of leases) {
      const delivery = retire(observer, 'closed');
      if (delivery) deliveries.push(delivery);
    }
    for (const delivery of deliveries) delivery.abort();
  }

  return { subscribe, publish, close };
}
