export type Capability<Api> =
  | { readonly kind: 'supported'; readonly api: Api }
  | { readonly kind: 'unsupported'; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly reason: string };
