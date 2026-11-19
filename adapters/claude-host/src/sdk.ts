import { query } from '@anthropic-ai/claude-agent-sdk';

/** Loads the SDK inside this project. The boolean return keeps that package out of the emitted declaration. */
export function claudeHostSdkLoaded(): boolean {
  return typeof query === 'function';
}
