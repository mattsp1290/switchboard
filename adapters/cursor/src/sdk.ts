import { Agent, JsonlLocalAgentStore } from '@cursor/sdk';

interface Launch {
  readonly apiKey: string;
  readonly model: { readonly id: string };
  readonly local: object;
}
interface Handle {
  readonly agentId: string;
  send(message: string): Promise<{
    supports(operation: 'cancel'): boolean;
    stream(): AsyncIterable<unknown>;
    wait(): Promise<{ status: string }>;
    cancel(): Promise<void>;
  }>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** Test seam. The isolated suite replaces these properties and restores them. */
export const sdk = {
  create: Agent.create.bind(Agent),
  resume: Agent.resume.bind(Agent),
  Store: JsonlLocalAgentStore,
} as {
  readonly create: (options: Launch) => Promise<Handle>;
  readonly resume: (agentId: string, options: Launch) => Promise<Handle>;
  readonly Store: new (directory: string) => object;
};
