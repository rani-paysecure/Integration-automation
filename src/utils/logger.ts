/* eslint-disable no-console -- this module is the single place allowed to write to the console */
import type { LogLevel } from '../types/config.types';
import { maskSensitiveData } from './masking';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  child(scope: string): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  scope?: string;
  /** Static context printed on every line, e.g. the environment name. */
  context?: string;
}

/**
 * Minimal structured logger. Every `meta` payload is passed through
 * `maskSensitiveData` so secrets never reach stdout or CI logs.
 */
export function createLogger(options: LoggerOptions): Logger {
  const { level, scope, context } = options;
  const threshold = LEVEL_WEIGHT[level];

  const write = (lineLevel: Exclude<LogLevel, 'silent'>, message: string, meta?: unknown): void => {
    if (LEVEL_WEIGHT[lineLevel] < threshold) return;
    const parts = [
      new Date().toISOString(),
      context ? `[${context}]` : undefined,
      `[${lineLevel.toUpperCase()}]`,
      scope ? `[${scope}]` : undefined,
      message,
    ].filter(Boolean);
    const line = parts.join(' ');
    const payload =
      meta === undefined ? '' : `\n${JSON.stringify(maskSensitiveData(meta), null, 2)}`;
    const sink =
      lineLevel === 'error' ? console.error : lineLevel === 'warn' ? console.warn : console.log;
    sink(`${line}${payload}`);
  };

  return {
    debug: (message, meta) => {
      write('debug', message, meta);
    },
    info: (message, meta) => {
      write('info', message, meta);
    },
    warn: (message, meta) => {
      write('warn', message, meta);
    },
    error: (message, meta) => {
      write('error', message, meta);
    },
    child: (childScope) =>
      createLogger({
        level,
        scope: scope ? `${scope}:${childScope}` : childScope,
        ...(context === undefined ? {} : { context }),
      }),
  };
}
