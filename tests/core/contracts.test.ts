import type {
  AdapterError,
  AdapterIdentity,
  AdapterInstance,
  AdapterRegistration,
  Capability,
  NativeExtension,
  Outcome,
} from '@mattsp1290/switchboard';

export interface Options {
  readonly endpoint: URL;
}

export interface Catalog {
  readonly listModels: (options: {
    readonly provider: string;
  }) => Promise<Outcome<readonly { readonly id: string; readonly contextWindow: number }[]>>;
}

export interface ExampleAdapter extends AdapterInstance<'acme/custom'> {
  readonly capabilities: {
    readonly modelCatalog: Capability<Catalog>;
  };
}

export declare const openExample: (options: Options) => Promise<Outcome<ExampleAdapter>>;
export declare const catalog: Capability<Catalog>;
export declare const catalogApi: Catalog;
export declare const extension: NativeExtension;
export declare const opened: Outcome<ExampleAdapter>;

export const identity = {
  engine: 'acme/custom',
  adapter: '@acme/switchboard-adapter',
  version: '1.0.0',
  contractVersion: 1,
} satisfies AdapterIdentity<'acme/custom'>;

export const registration: AdapterRegistration<Options, ExampleAdapter> = {
  identity,
  open: openExample,
};

const pending = registration.open({ endpoint: new URL('http://localhost:9000') });
const concrete: Promise<Outcome<ExampleAdapter>> = pending;
void concrete;

export const supported = { kind: 'supported', api: catalogApi } satisfies Capability<Catalog>;
export const unsupported = { kind: 'unsupported', reason: 'Not implemented.' } satisfies Capability<Catalog>;
export const unavailable = { kind: 'unavailable', reason: 'Disabled by host.' } satisfies Capability<Catalog>;

export async function inspect(instance: ExampleAdapter): Promise<void> {
  const feature = instance.capabilities.modelCatalog;
  switch (feature.kind) {
    case 'supported': {
      const models = await feature.api.listModels({ provider: 'acme' });
      if (models.kind === 'ok') {
        const window: number | undefined = models.value[0]?.contextWindow;
        void window;
      } else {
        const error: AdapterError = models.error;
        void error;
      }
      break;
    }
    case 'unsupported':
    case 'unavailable': {
      const reason: string = feature.reason;
      void reason;
      break;
    }
    default: {
      const exhaustive: never = feature;
      void exhaustive;
    }
  }
  const cleanup = await instance.close();
  if (cleanup.kind === 'ok') {
    const result: void = cleanup.value;
    void result;
  } else {
    const error: AdapterError = cleanup.error;
    void error;
  }
}

export declare const minimalOpen: () => Promise<Outcome<AdapterInstance<'acme/minimal'>>>;
export const minimal = {
  identity: { ...identity, engine: 'acme/minimal' },
  open: minimalOpen,
} satisfies AdapterRegistration<void, AdapterInstance<'acme/minimal'>>;

export const nativeData: NativeExtension<{ readonly modelAlias: string }> = {
  namespace: '@acme/switchboard-adapter/model',
  schemaVersion: 1,
  data: { modelAlias: 'fast' },
};
const alias: string = nativeData.data.modelAlias;
const opaque: NativeExtension = nativeData;
const unknownData: unknown = opaque.data;
void alias;
void unknownData;

export declare const nativeOutcome: Outcome<number, { readonly code: 'acme-fault'; readonly detail: number }>;
if (nativeOutcome.kind === 'error') {
  const detail: number = nativeOutcome.error.detail;
  void detail;
}
