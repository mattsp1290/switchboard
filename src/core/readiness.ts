/** One adapter's bounded local observations at `observedAt`. A report never promises that later native work succeeds. */
export type ReadinessFact = 'installation' | 'version' | 'authentication' | 'workspace';
/**
 * None of these is evidence of absence. `timed_out` and `unknown` mean a probe ran without positive evidence.
 * `cancelled` means the host signal stopped the check, possibly before the probe started.
 * `not_checked` means a probe exists but was skipped. `unsupported` means the adapter has no probe for the fact.
 */
export type UnobservedState = 'timed_out' | 'cancelled' | 'unknown' | 'not_checked' | 'unsupported';
type Is<State extends string> = { readonly state: State };
type Qualified = { readonly state: 'qualified'; readonly required: string; readonly observed: string };
type SignedIn = { readonly state: 'signed_in'; readonly method: 'chatgpt' };
export type InstallationObservation = Is<'available' | 'not_installed' | 'not_executable' | UnobservedState>;
export type VersionObservation =
  | Qualified | { readonly state: 'mismatch'; readonly required: string; readonly observed: string } | Is<UnobservedState>;
export type AuthenticationObservation = SignedIn | Is<'sign_in_required' | 'unsupported_method' | UnobservedState>;
export type WorkspaceObservation = Is<'accessible' | 'inaccessible' | UnobservedState>;
export interface ReadinessFacts {
  readonly installation: InstallationObservation;
  readonly version: VersionObservation;
  readonly authentication: AuthenticationObservation;
  readonly workspace: WorkspaceObservation;
}
/** A positively observed condition that the user can fix. */
export type ReadinessActionCode = 'install_required' | 'version_required' | 'sign_in_required' | 'workspace_unavailable';
/** Nothing blocking was observed, but readiness was not established. */
export type ReadinessUnknownCode = 'retry_check' | 'check_cancelled' | 'runtime_closed' | 'check_unavailable';
export type ReadinessRemediationCode = ReadinessActionCode | ReadinessUnknownCode;
interface ReportBase {
  readonly provider: 'codex' | 'claude' | 'pi' | 'cursor';
  /** ISO 8601 host time when the probes finished. */
  readonly observedAt: string;
  /** Facts with positive evidence, passing or failing, in `ReadinessFact` order. */
  readonly checked: readonly ReadinessFact[];
}
/** Adapters derive the verdict and remediation from `facts`; the type does not encode that derivation. */
export type ReadinessReport =
  | ReportBase & {
    readonly verdict: 'ready';
    readonly remediation: null;
    readonly facts: {
      readonly installation: Is<'available'>; readonly version: Qualified;
      readonly authentication: SignedIn; readonly workspace: Is<'accessible' | 'unsupported'>;
    };
  }
  | ReportBase & {
    readonly verdict: 'blocked';
    readonly remediation: { readonly code: ReadinessActionCode; readonly message: string };
    readonly facts: ReadinessFacts;
  }
  | ReportBase & {
    readonly verdict: 'unverified';
    readonly remediation: { readonly code: ReadinessUnknownCode; readonly message: string };
    readonly facts: ReadinessFacts;
  };
/** Every text runtime satisfies this, so a host can hold them in one collection. */
export interface ReadinessSource {
  readinessReport(options?: { readonly signal?: AbortSignal }): Promise<ReadinessReport>;
}
