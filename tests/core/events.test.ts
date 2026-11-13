import {
  createEventStream,
  type EventListener,
  type EventObserver,
  type EventStream,
  type EventStreamBounds,
  type Outcome,
  type PublishResult,
  type SubscribeError,
  type Subscription,
  type SubscriptionEnd,
} from '@mattsp1290/switchboard';

type NativeEvent = { readonly vendorKind: string; readonly usage: { readonly tokens: number } };
const bounds = { maxObservers: 2, capacity: 8 } satisfies EventStreamBounds;
export const events: EventStream<NativeEvent> = createEventStream<NativeEvent>(bounds);
export const observer: EventObserver<NativeEvent> = { subscribe: events.subscribe };
export const listener: EventListener<NativeEvent> = (event, signal) => {
  const tokens: number = event.usage.tokens;
  const aborted: boolean = signal.aborted;
  void tokens;
  void aborted;
};
export const subscribed: Outcome<Subscription, SubscribeError> = observer.subscribe(listener, {
  signal: new AbortController().signal,
});
export const report: PublishResult = events.publish({ vendorKind: 'reported-usage', usage: { tokens: 3 } });
if (report.kind === 'published') {
  const counts: readonly number[] = [report.enqueued, report.disconnected];
  void counts;
}
if (subscribed.kind === 'ok') {
  const ended: Promise<SubscriptionEnd> = subscribed.value.ended;
  subscribed.value.dispose();
  void ended;
} else {
  const code: 'closed' | 'capacity' = subscribed.error.code;
  void code;
}
export function terminal(reason: SubscriptionEnd): string {
  switch (reason) {
    case 'disposed':
    case 'aborted':
    case 'overflow':
    case 'listener-error':
    case 'closed':
      return reason;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
events.close();
