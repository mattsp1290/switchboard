import type { Message, ToolCall } from '@ag-ui/core';
import type { Json, NativeContent, NativeMessage } from '@mattsp1290/switchboard/agui';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
type ShapePreserved<M extends Message> = Equal<keyof M, keyof NativeMessage<M>> extends true
  ? Equal<RequiredKeys<M>, RequiredKeys<NativeMessage<M>>> : false;
export type RoleCoverage = Assert<Equal<NativeMessage['role'], Message['role']>>;
export type KeysAndOptionalityPreserved = Assert<Equal<{
  [R in Message['role']]: ShapePreserved<Extract<Message, { role: R }>>
}[Message['role']], true>>;
export type MetadataObject = Assert<Equal<NonNullable<NativeMessage['metadata']>, { readonly [key: string]: Json }>>;
export type UserContentReused = Assert<Equal<Extract<NativeMessage, { role: 'user' }>['content'], NativeContent>>;
export type ToolContentReused = Assert<Equal<Extract<NativeMessage, { role: 'tool' }>['content'], NativeContent>>;
export type CallKeysPreserved = Assert<Equal<keyof NonNullable<Extract<NativeMessage, { role: 'assistant' }>['toolCalls']>[number], keyof ToolCall>>;
