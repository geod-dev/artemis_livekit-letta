export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ConsoleLoggerOptions {
  /**
   * Lowest level printed. Default: `debug` when `LOG_LEVEL=debug` is set in the
   * environment at creation, otherwise `info`. Read once, never per call.
   */
  level?: LogLevel;
}

const RANK: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Console logger: `[scope] message {fields}`. Children keep the level. */
export function consoleLogger(scope = 'app', options: ConsoleLoggerOptions = {}): Logger {
  return loggerAt(scope, options.level ?? (process.env.LOG_LEVEL === 'debug' ? 'debug' : 'info'));
}

function loggerAt(scope: string, level: LogLevel): Logger {
  const threshold = RANK[level];
  const line = (message: string, fields?: Record<string, unknown>) =>
    fields && Object.keys(fields).length
      ? [`[${scope}] ${message}`, fields]
      : [`[${scope}] ${message}`];
  return {
    debug: (m, f) => (threshold <= RANK.debug ? console.debug(...line(m, f)) : undefined),
    info: (m, f) => (threshold <= RANK.info ? console.info(...line(m, f)) : undefined),
    warn: (m, f) => (threshold <= RANK.warn ? console.warn(...line(m, f)) : undefined),
    error: (m, f) => (threshold <= RANK.error ? console.error(...line(m, f)) : undefined),
    child: (child) => loggerAt(`${scope}:${child}`, level),
  };
}
