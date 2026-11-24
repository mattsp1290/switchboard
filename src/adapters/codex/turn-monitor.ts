import type { CodexInterruptResult, CodexTurnCompletion } from './execution.js';

export interface CodexObservedInterrupt {
  readonly result: () => CodexInterruptResult | undefined;
}
export interface CodexTurnMonitor {
  readonly result: () => CodexTurnCompletion | undefined;
  readonly segment: (listener: () => void) => () => void;
  readonly interruptWaiter: (listener: () => void) => (() => void) | undefined;
  readonly interrupt: (start: () => Promise<CodexInterruptResult>) => CodexObservedInterrupt;
}

/** One completion reaction, one native interrupt attempt, and removable bounded public waiters per turn. */
export function monitorCodexTurn(completion: Promise<CodexTurnCompletion>): CodexTurnMonitor {
  let result: CodexTurnCompletion | undefined;
  let segment: (() => void) | undefined;
  let interrupt: CodexObservedInterrupt | undefined;
  const waiters = new Set<() => void>();
  const changed = () => { segment?.(); for (const listener of waiters) listener(); };
  void completion.then((value) => { result = value; changed(); });
  return {
    result: () => result,
    segment(listener) {
      if (segment) throw new Error('A turn already has a segment waiter');
      segment = listener;
      return () => { if (segment === listener) segment = undefined; };
    },
    interruptWaiter(listener) {
      if (waiters.size >= 63) return undefined;
      waiters.add(listener);
      return () => { waiters.delete(listener); };
    },
    interrupt(start) {
      if (interrupt) return interrupt;
      let value: CodexInterruptResult | undefined;
      const attempt = { result: () => value };
      interrupt = attempt;
      const finish = (received: CodexInterruptResult) => {
        value = received;
        changed();
        if (interrupt === attempt && (received.step === 'not-sent' || received.step === 'not-needed')) interrupt = undefined;
      };
      void Promise.resolve().then(start).then(finish, () => finish({ step: 'uncertain', turnId: null, rejection: null }));
      return attempt;
    },
  };
}
