import { Codex, type CodexOptions, type ThreadEvent } from '@openai/codex-sdk';

export const options = {
  env: {},
  config: { model_provider: 'fixture', model_providers: { fixture: {
    name: 'Fixture', base_url: 'http://127.0.0.1:1/v1', wire_api: 'responses',
    supports_websockets: false, request_max_retries: 0, stream_max_retries: 0,
    auth: { command: '/fixture/token', args: [], refresh_interval_ms: 1000, timeout_ms: 5000 },
  } } },
} satisfies CodexOptions;
export function resume(client: Codex, nativeId: string): ReturnType<Codex['resumeThread']> {
  return client.resumeThread(nativeId);
}
export type RawSdkEvent = ThreadEvent;
