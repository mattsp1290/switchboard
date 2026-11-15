import type { PiTerminal } from './index.js';

export function terminalOutcome(stopReason: string | undefined, interruptedBeforeResponse: boolean): PiTerminal['outcome'] {
  if (stopReason === 'stop' || stopReason === 'length') return 'completed';
  if (stopReason === 'aborted' || (stopReason === undefined && interruptedBeforeResponse)) return 'interrupted';
  return 'failed';
}
