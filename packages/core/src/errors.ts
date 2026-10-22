/** Thrown by contract stubs until a work package implements them. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented: ${what}`);
    this.name = 'NotImplementedError';
  }
}

export function notImplemented(what: string): never {
  throw new NotImplementedError(what);
}

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
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string) {
    super(code, message, 409);
  }
}

export class BusyError extends AppError {
  constructor(message = 'Too many pending turns') {
    super('busy', message, 429);
  }
}
