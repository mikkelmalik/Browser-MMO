export class DomainError extends Error {
  /**
   * `status` overrides the API's default HTTP mapping when a code needs one
   * that the `_not_found → 404, else 409` heuristic doesn't cover (e.g. 401).
   */
  constructor(readonly code: string, message: string, readonly status?: number) {
    super(message)
  }
}
