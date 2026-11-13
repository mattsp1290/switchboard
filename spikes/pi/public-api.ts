import type {
  AgentSession,
  CreateAgentSessionOptions,
  ExtensionFactory,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { CredentialStore } from "@earendil-works/pi-ai";

export type NativeSelection = {
  options: CreateAgentSessionOptions;
  credentials: CredentialStore;
  extension: ExtensionFactory;
  discover: typeof SessionManager.list;
  reopen: typeof SessionManager.open;
  prompt: AgentSession["prompt"];
  cancel: AgentSession["abort"];
  subscribe: AgentSession["subscribe"];
  resolveCredential: ModelRuntime["getAuth"];
};
