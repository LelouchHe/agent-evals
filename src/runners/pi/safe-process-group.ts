/**
 * Validate a candidate process-group id before the sandboxed supervisor sends
 * any signal. The registry is agent-writable, so this is a safety filter, not
 * an authorization mechanism: the supervisor itself runs inside Seatbelt and
 * can signal only processes in the same sandbox.
 */
export function isSafeProcessGroup(value: unknown): value is number {
  if (typeof value === "string" && !/^[1-9][0-9]*$/.test(value)) {
    return false;
  }
  const pgid = typeof value === "number" ? value : Number(value);
  return (
    Number.isSafeInteger(pgid) &&
    pgid > 1 &&
    pgid <= 2_147_483_647 &&
    pgid !== process.pid
  );
}
