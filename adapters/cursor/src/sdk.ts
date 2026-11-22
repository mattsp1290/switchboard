import { Agent, Cursor, JsonlLocalAgentStore } from '@cursor/sdk';

interface Launch {
  readonly apiKey: string;
  readonly model: { readonly id: string };
  readonly local: object;
}
export type CursorMessage = string | { readonly text: string; readonly images: { data: string; mimeType: string }[] };
interface Handle {
  readonly agentId: string;
  send(message: CursorMessage): Promise<{
    supports(operation: 'cancel'): boolean;
    stream(): AsyncIterable<unknown>;
    wait(): Promise<{ status: string }>;
    cancel(): Promise<void>;
  }>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** Test seam. The isolated suite replaces these properties and restores them. */
export const sdk: {
  readonly create: (options: Launch) => Promise<Handle>;
  readonly resume: (agentId: string, options: Launch) => Promise<Handle>;
  readonly Store: new (directory: string) => object;
  readonly listModels: (options: { readonly apiKey: string }) => Promise<unknown>;
} = {
  create: Agent.create.bind(Agent),
  resume: Agent.resume.bind(Agent),
  Store: JsonlLocalAgentStore,
  listModels: Cursor.models.list.bind(Cursor.models),
};
