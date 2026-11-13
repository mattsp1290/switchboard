export interface AdapterIdentity<Engine extends string = string> {
  readonly engine: Engine;
  readonly adapter: string;
  readonly version: string;
  readonly contractVersion: 1;
}

export type AdapterError =
  | { readonly code: 'unsupported'; readonly feature: string; readonly message: string }
  | {
      readonly code: 'busy' | 'closed' | 'invalid-input' | 'native-failure';
      readonly message: string;
    };

export type Outcome<T, E = AdapterError> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'error'; readonly error: E };

export interface AdapterInstance<Engine extends string = string> {
  readonly identity: AdapterIdentity<Engine>;
  readonly close: () => Promise<Outcome<void>>;
}

export interface AdapterRegistration<Options, Instance extends AdapterInstance> {
  readonly identity: Instance['identity'];
  readonly open: (options: Options) => Promise<Outcome<Instance>>;
}

export interface NativeExtension<T = unknown> {
  readonly namespace: string;
  readonly schemaVersion: number;
  readonly data: T;
}
