import type { AssistantMessage } from '@earendil-works/pi-ai';
import { emitObservation, tokenCount, usageFromCounts } from '#switchboard';
import type { RunObservationListener, RunObservationOutcome, RunObservationUsage } from '#switchboard';

/**
 * The observation-only state for one Pi prompt. Snapshots are per native assistant message, so a second message in
 * one prompt starts a new id. The caller invokes `message` only once the prompt is admitted.
 */
export function createMessageObserver(listener: RunObservationListener | undefined) {
  let messageIndex = 0;
  let text = '';
  let thinking = '';
  let thinkingSeen = false;
  let usage: RunObservationUsage | undefined;
  return {
    message(message: AssistantMessage, ended: boolean): void {
      if (!listener) return;
      const messageId = `assistant:${messageIndex}`;
      const nextText = message.content.filter(part => part.type === 'text').map(part => part.text).join('');
      if (nextText !== '' && nextText !== text) {
        text = nextText;
        emitObservation(listener, { kind: 'text', messageId, mode: 'snapshot', text: nextText });
      }
      const nextThinking = message.content.filter(part => part.type === 'thinking').map(part => part.thinking).join('');
      if (nextThinking !== '' && nextThinking !== thinking) {
        thinkingSeen = true;
        thinking = nextThinking;
        emitObservation(listener, { kind: 'reasoning', messageId, mode: 'snapshot', text: nextThinking });
      }
      if (ended) {
        const { input, output } = message.usage ?? {};
        if (tokenCount(input) !== undefined && tokenCount(output) !== undefined) {
          usage = usageFromCounts({ inputTokens: input, outputTokens: output });
        }
        messageIndex++;
        text = '';
        thinking = '';
      }
    },
    /** The final `unsupported` reasoning (when none was seen), `usage`, and `terminal` observations. */
    finish(outcome: RunObservationOutcome): void {
      if (!thinkingSeen) emitObservation(listener, { kind: 'unsupported', family: 'reasoning' });
      if (usage) emitObservation(listener, { kind: 'usage', rows: [usage] });
      emitObservation(listener, { kind: 'terminal', outcome });
    },
  };
}
