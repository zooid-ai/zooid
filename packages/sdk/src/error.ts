/**
 * Error thrown by {@link ZooidClient} when the server returns a non-2xx response.
 *
 * The `status` property contains the HTTP status code, and `message` contains
 * the error description from the response body (or a fallback like `"HTTP 500"`).
 */
export class ZooidError extends Error {
  /** HTTP status code from the server response. */
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ZooidError';
    this.status = status;
  }
}
