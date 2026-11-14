import type { Label } from '@switchboard-proof/declarations';
import { format } from './helper.js';

export interface Result {
  readonly text: Label;
}
export function describe(value: string): Result {
  return { text: format(value) };
}
