export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

/** Console logger: `[scope] message {fields}`. */
export function consoleLogger(scope = 'app'): Logger {
  const line = (message: string, fields?: Record<string, unknown>) =>
    fields && Object.keys(fields).length ? [`[${scope}] ${message}`, fields] : [`[${scope}] ${message}`];
  return {
    debug: (m, f) => (process.env.LOG_LEVEL === 'debug' ? console.debug(...line(m, f)) : undefined),
    info: (m, f) => console.info(...line(m, f)),
    warn: (m, f) => console.warn(...line(m, f)),
    error: (m, f) => console.error(...line(m, f)),
    child: (child) => consoleLogger(`${scope}:${child}`),
  };
}
