import type { HostAdapterEvent } from '../../core/host-adapter.js';
import type { CodexInteractionEvent } from './interaction.js';

/** Projects bridge lifetime facts; successful replies retain the separate delivery contract. */
export function codexSettlement(event: CodexInteractionEvent): Extract<HostAdapterEvent, { kind: 'interaction-settled' }> | undefined {
  if (event.kind !== 'settled' && event.kind !== 'host-settled') return undefined;
  const { settlement } = event;
  if (settlement.kind === 'replied') return undefined;
  const data = settlement.kind === 'withdrawn' ? { kind: settlement.kind, by: settlement.by }
    : settlement.kind === 'expired' ? { kind: settlement.kind } : { kind: settlement.kind, cause: settlement.cause };
  return Object.freeze({ kind: 'interaction-settled', target: event.target,
    settlement: Object.freeze({ namespace: 'codex-app-server/interaction-settlement', schemaVersion: 1, data: Object.freeze(data) }) });
}
