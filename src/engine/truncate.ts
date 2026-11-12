/** Truncate a string to a UTF-16 code-unit limit, appending an ellipsis when cut. */
export function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit) + "…";
}

export function truncateNullable(value: string | null, limit: number): string | null {
  return value === null ? null : truncate(value, limit);
}
