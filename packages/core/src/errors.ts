/** An error with a stable machine code, mapped to HTTP statuses at the API edge. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 500,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super('not_found', `${what} not found`, 404);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string) {
    super(code, message, 409);
    this.name = 'ConflictError';
  }
}

export class BusyError extends AppError {
  constructor(message = 'Too many pending turns') {
    super('busy', message, 429);
    this.name = 'BusyError';
  }
}

/** The message of any thrown value: an Error's message, otherwise its string form. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
