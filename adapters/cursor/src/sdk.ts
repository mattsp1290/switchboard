import { Agent, JsonlLocalAgentStore } from '@cursor/sdk';

/** Test seam. The isolated suite replaces these properties and restores them. */
export const sdk = {
  create: Agent.create.bind(Agent),
  resume: Agent.resume.bind(Agent),
  Store: JsonlLocalAgentStore,
};
