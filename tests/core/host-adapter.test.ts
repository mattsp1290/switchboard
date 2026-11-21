import type {
  AdapterError, AuthConfiguration, CheckpointReference, CredentialResolver, EventObserver, HostAdapter, HostAdapterCapabilities,
  HostAdapterError, HostAdapterEvent, HostAdapterRegistration, HostInterruptResult, HostLaunch, HostOpenOptions,
  HostRouteCredential, HostSegmentResult, HostToolCall, HostWriteStatus, InteractionContinuation, PendingInteraction,
  ResolvedAuthentication, SessionReference,
} from '@operatorworks/switchboard';
import { sessionReference } from './sessions.test.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

export type WriteKinds = Expect<Equal<HostWriteStatus['kind'], 'not-attempted' | 'not-dispatched' | 'outcome-unknown' | 'accepted'>>;
export type SegmentKinds = Expect<Equal<HostSegmentResult['kind'], 'complete' | 'pending' | 'failed'>>;
export type InterruptKinds = Expect<Equal<HostInterruptResult['kind'], 'terminal-observed' | 'interrupted' | 'unconfirmed-within-bound'>>;
export type AdapterErrorsKept = Expect<AdapterError extends HostAdapterError ? true : false>;
export type ErrorCodes = Expect<Equal<HostAdapterError['code'],
  AdapterError['code'] | 'history-mismatch' | 'pending-limit' | 'unavailable'>>;
export type CorePending = Expect<Equal<HostToolCall['pending'], Extract<PendingInteraction, { readonly kind: 'tool' }>>>;
export type CoreAnswers = Expect<Equal<Parameters<HostAdapter['continue']>[0]['answers'], readonly InteractionContinuation[]>>;
export type CoreFingerprint = Expect<Equal<NonNullable<HostOpenOptions['resume']>['expectedHistory'], CheckpointReference | undefined>>;
export type FixedTools = Expect<Equal<HostAdapterCapabilities['toolDeclarations'], 'fixed-at-creation'>>;
export type EventKinds = Expect<Equal<HostAdapterEvent['kind'], 'text-delta' | 'tool-call-start' | 'tool-call-arguments-delta'
  | 'tool-call-end' | 'tool-delivery' | 'usage' | 'native-item'>>;
export type LaunchKinds = Expect<Equal<HostLaunch['kind'], 'spawn' | 'channel' | 'in-process'>>;
export type PendingLimitWrite = Expect<Equal<Extract<HostSegmentResult, { kind: 'failed'; error: { code: 'pending-limit' } }>['write']['kind'], 'accepted'>>;
export type CredentialForms = Expect<Equal<HostRouteCredential['form'], 'none' | 'bearer' | 'helper'>>;
export type ResolvedRoute = Expect<Equal<Extract<ResolvedAuthentication<unknown>, { kind: 'host-route' }>['material'], HostRouteCredential>>;

export const nativeDefaults = {} satisfies HostOpenOptions;
export declare const hostRouteResolver: CredentialResolver<HostRouteCredential>;
export const loopbackRoute = {
  kind: 'host-route', endpoint: 'http://127.0.0.1:41234', protocol: 'responses', model: 'fixture/model',
  credentialPurpose: 'host-route', credentialForm: 'none', principal: 'crew-relay', resolve: hostRouteResolver,
} satisfies AuthConfiguration<unknown>;
export const configured = {
  launch: { kind: 'spawn', spawn: () => undefined }, instructions: 'Answer briefly.', subagents: 'off', builtInTools: ['view_image'],
  environment: { variables: { PATH: '/usr/bin' }, nativeConfig: { sandbox: 'read-only' } },
  tools: [{ name: 'lookup', description: 'Looks up a value.', inputSchema: { type: 'object' } }],
  route: { config: loopbackRoute, scope: { engine: 'codex', account: 'a', adapterInstanceId: 'i', sessionId: 's' } },
  resume: { session: sessionReference },
} satisfies HostOpenOptions;

declare const events: EventObserver<HostAdapterEvent>;
declare const capabilities: HostAdapterCapabilities;
export const adapter: HostAdapter<'fixture'> = {
  identity: { engine: 'fixture', adapter: 'example', version: '1', contractVersion: 1 },
  capabilities, events,
  run: async () => ({ kind: 'failed', error: { code: 'unsupported', feature: 'run', message: 'Example.' }, write: { kind: 'not-attempted' } }),
  continue: async () => ({ kind: 'failed', error: { code: 'native-failure', message: 'Example.' },
    write: { kind: 'not-dispatched', reason: 'aborted' } }),
  interrupt: async () => ({ kind: 'unconfirmed-within-bound' }),
  close: async () => ({ kind: 'ok', value: undefined }),
};
export const registration: HostAdapterRegistration<HostOpenOptions, 'fixture'> = {
  identity: adapter.identity,
  open: async () => ({ kind: 'ok', value: adapter }),
};

export function describe(result: HostSegmentResult): SessionReference | HostAdapterError {
  switch (result.kind) {
    case 'complete': return result.session;
    case 'pending': return result.calls[0]?.pending.target.session ?? result.session;
    case 'failed': return result.error;
    default: { const exhaustive: never = result; return exhaustive; }
  }
}
