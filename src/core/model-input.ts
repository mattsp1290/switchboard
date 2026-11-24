/** Explicit model IDs selected for the isolated text runtimes. */
export function callerModelId(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 256 || /\p{Cs}/u.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}
