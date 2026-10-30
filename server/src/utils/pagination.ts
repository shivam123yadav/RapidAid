export interface PaginationOptions {
  defaultLimit: number;
  maxLimit: number;
  maxSkip?: number;
}

export interface ParsedPagination {
  limit: number;
  skip: number;
}

/**
 * Normalizes and bounds pagination query parameters (limit and skip).
 * Enforces:
 *  - 1 <= limit <= maxLimit (falls back to defaultLimit on NaN or non-positive)
 *  - 0 <= skip <= maxSkip (falls back to 0 on NaN or negative; bounds max offset)
 */
export function parsePagination(
  query: { limit?: unknown; skip?: unknown },
  options: PaginationOptions,
): ParsedPagination {
  const maxSkip = options.maxSkip ?? 10_000;

  const rawLimit = Number.parseInt(String(query.limit ?? ''), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, options.maxLimit)
    : options.defaultLimit;

  const rawSkip = Number.parseInt(String(query.skip ?? ''), 10);
  const skip = Number.isFinite(rawSkip) && rawSkip > 0
    ? Math.min(rawSkip, maxSkip)
    : 0;

  return { limit, skip };
}
