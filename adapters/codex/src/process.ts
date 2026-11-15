import { AsyncLocalStorage } from 'node:async_hooks';
import { ChildProcess } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';

const currentRun = new AsyncLocalStorage<symbol>();
const spawned = channel('tracing:child_process.spawn:end');

// The SDK removes its child listeners on return. Its generator can finish before the child exits.
export async function withSdkProcess<T>(signal: AbortSignal, consume: () => Promise<T>): Promise<T> {
  const run = Symbol();
  let child: ChildProcess | undefined;
  let force: NodeJS.Timeout | undefined;
  let stdinFailure = false;
  function observe(message: unknown): void {
    if (currentRun.getStore() !== run || !message || typeof message !== 'object'
      || !('process' in message) || !(message.process instanceof ChildProcess)) return;
    child = message.process;
    const running = child;
    // The diagnostics event fires before spawn initializes stdin. Writes report errors asynchronously.
    queueMicrotask(() => running.stdin?.on('error', () => { stdinFailure = true; }));
    spawned.unsubscribe(observe);
  }
  function escalate(): void {
    if (!force) force = setTimeout(() => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 1_000);
  }

  spawned.subscribe(observe);
  signal.addEventListener('abort', escalate, { once: true });
  try {
    const result = await currentRun.run(run, consume);
    if (stdinFailure) throw new Error('Codex input failed.');
    return result;
  } finally {
    spawned.unsubscribe(observe);
    signal.removeEventListener('abort', escalate);
    if (child && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      const running = child;
      const exited = new Promise<void>(resolve => running.once('exit', () => resolve()));
      running.kill('SIGTERM');
      escalate();
      await exited;
    }
    clearTimeout(force);
  }
}
