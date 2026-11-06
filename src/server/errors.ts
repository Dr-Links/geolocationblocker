/** Errors whose message is safe to show to the end user. */
export class AppError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = new.target.name;
  }
}
export class ForbiddenError extends AppError {
  constructor(message = "You don't have permission to do that") {
    super(message, "FORBIDDEN", 403);
  }
}
export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(message, "NOT_FOUND", 404);
  }
}
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, "CONFLICT", 409);
  }
}
export class RateLimitError extends AppError {
  constructor(readonly retryAfterSec: number) {
    super(`Too many attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).`, "RATE_LIMITED", 429);
  }
}
