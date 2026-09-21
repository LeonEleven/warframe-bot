/**
 * 极简结构化日志。
 * - info/debug 输出到 stdout，warn/error 输出到 stderr
 * - 只依赖 Node 内置能力，方便在测试里替换成内存 logger
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

function toText(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 把任意异常转成可读文本（包含 Error.cause 链）。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause: unknown = (error as { cause?: unknown }).cause;
    const base = `${error.name}: ${error.message}`;
    return cause === undefined ? base : `${base} <- ${describeError(cause)}`;
  }
  return toText(error);
}

function writeLine(stream: NodeJS.WriteStream, level: LogLevel, message: string, meta?: unknown): void {
  const timestamp = new Date().toISOString();
  const suffix = meta === undefined ? '' : ` ${toText(meta)}`;
  stream.write(`[${timestamp}] ${level.toUpperCase().padEnd(5, ' ')} ${message}${suffix}\n`);
}

export function createLogger(level: LogLevel = 'info'): Logger {
  const threshold = LEVEL_WEIGHT[level];
  const enabled = (candidate: LogLevel): boolean => LEVEL_WEIGHT[candidate] >= threshold;

  return {
    level,
    debug: (message, meta) => {
      if (enabled('debug')) writeLine(process.stdout, 'debug', message, meta);
    },
    info: (message, meta) => {
      if (enabled('info')) writeLine(process.stdout, 'info', message, meta);
    },
    warn: (message, meta) => {
      if (enabled('warn')) writeLine(process.stderr, 'warn', message, meta);
    },
    error: (message, meta) => {
      if (enabled('error')) writeLine(process.stderr, 'error', message, meta);
    },
  };
}

/** 测试与脚本共用的“什么都不打印”的 logger。 */
export function createSilentLogger(level: LogLevel = 'error'): Logger {
  return {
    level,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}
