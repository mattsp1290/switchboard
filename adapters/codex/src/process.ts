import { AsyncLocalStorage } from 'node:async_hooks';
import { ChildProcess } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';

const currentRun = new AsyncLocalStorage<symbol>();
const spawned = channel('tracing:child_process.spawn:end');

// The SDK removes its child listeners on return. Its generator can finish before the child exits.
export async function withSdkProcess(signal: AbortSignal, consume: () => Promise<void>): Promise<void> {
  const run = Symbol();
  let child: ChildProcess | undefined;
  let force: NodeJS.Timeout | undefined;
  function observe(message: unknown): void {
    if (currentRun.getStore() !== run || !message || typeof message !== 'object'
      || !('process' in message) || !(message.process instanceof ChildProcess)) return;
    child = message.process;
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
    await currentRun.run(run, consume);
  } finally {
    spawned.unsubscribe(observe);
    signal.removeEventListener('abort', escalate);
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child?.once('exit', () => resolve()));
      child.kill('SIGTERM');
      escalate();
      await exited;
    }
    clearTimeout(force);
  }
}
