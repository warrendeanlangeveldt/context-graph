/**
 * Every failure the domain can report. `code` is part of the API contract: the HTTP layer maps it to a
 * status and returns it to clients verbatim, so codes are never renamed once shipped.
 */
export type ErrorCode = 'NOT_FOUND' | 'INVALID_TRANSITION' | 'SLOT_TAKEN' | 'VALIDATION' | 'LIMIT';

export class DomainError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
  }
}
