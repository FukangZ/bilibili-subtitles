/** Explicit secrets only: callers decide which credentials may appear upstream. */
export function redact(text: string, secrets: readonly string[]): string {
  return secrets.filter(Boolean).reduce((current, secret) => current.split(secret).join("[redacted]"), text);
}
