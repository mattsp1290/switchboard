import { createAuthContext } from '@mattsp1290/switchboard';
import type {
  AuthBoundary,
  AuthConfiguration,
  AuthError,
  AuthResolutionContext,
  AuthScope,
  CredentialResolver,
  Outcome,
  ProxyCredential,
  ResolvedAuthentication,
  ScopedAuth,
} from '@mattsp1290/switchboard';

interface NativeMaterial {
  readonly mechanism: 'native-sign-in';
  readonly credentialHandle: { readonly nativeIdentity: string };
}
interface NativeOptions {
  readonly family: 'custom-native';
  readonly nativeFeature: readonly string[];
}
export const authScope = {
  engine: 'acme/native', account: 'account-a', adapterInstanceId: 'adapter-a', sessionId: 'session-a',
} satisfies AuthScope;
export const request = {
  boundary: 'request', invocationId: 'invocation-a', requestId: 'request-a',
} satisfies AuthBoundary;
export const invocation = { boundary: 'invocation', invocationId: 'invocation-b' } satisfies AuthBoundary;
export declare const signal: AbortSignal;
export declare const directResolver: CredentialResolver<NativeMaterial>;
export declare const proxyResolver: CredentialResolver<ProxyCredential>;
export const directConfig = {
  kind: 'direct', model: 'custom/alias', resolve: directResolver,
  nativeOptions: { family: 'custom-native', nativeFeature: ['native-sign-in'] },
} satisfies AuthConfiguration<NativeMaterial, NativeOptions>;
export const proxyConfig = {
  kind: 'litellm', endpoint: 'http://proxy.internal/custom/root', model: 'custom/alias',
  protocol: 'adapter-qualified-protocol', headers: { 'x-native-version': 'example' },
  credentialPurpose: 'litellm-proxy', resolve: proxyResolver,
} satisfies AuthConfiguration<NativeMaterial>;
export const configured = createAuthContext<NativeMaterial, NativeOptions>({ config: directConfig, scope: authScope });
export declare const scoped: ScopedAuth<NativeMaterial, NativeOptions>;
const pending: Promise<Outcome<ResolvedAuthentication<NativeMaterial, NativeOptions>, AuthError>> = scoped.resolve(request, signal);
void pending;

export async function consume(): Promise<void> {
  const resolved = await scoped.resolve(invocation, signal);
  if (resolved.kind === 'error') {
    const code: AuthError['code'] = resolved.error.code;
    void code;
    return;
  }
  if (resolved.value.kind === 'direct') {
    const handle: string = resolved.value.material.credentialHandle.nativeIdentity;
    const options: NativeOptions | undefined = resolved.value.nativeOptions;
    void handle;
    void options;
  } else {
    const purpose: 'litellm-proxy' = resolved.value.material.purpose;
    const token: string = resolved.value.material.token;
    void purpose;
    void token;
  }
}
export function readContext(context: AuthResolutionContext): string {
  const session: string = context.scope.sessionId;
  return context.boundary === 'request' ? `${session}/${context.requestId}` : context.invocationId;
}
