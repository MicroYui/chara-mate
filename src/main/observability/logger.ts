import pino from "pino";
import type { DestinationStream, LoggerOptions } from "pino";

import { redactBoundaryValue, redactText } from "../../shared/pure/redaction";

export type LogContext = Readonly<Record<string, unknown>> | Error;

export interface AppLogger {
  debug(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
}

export interface AppLoggerOptions {
  destination?: DestinationStream;
  level?: LoggerOptions["level"];
}

export function createAppLogger(options: AppLoggerOptions = {}): AppLogger {
  const logger = pino(
    {
      level: options.level ?? "info",
    },
    options.destination,
  );

  function safeContext(context: LogContext): Record<string, unknown> {
    const redacted = redactBoundaryValue(context);
    return typeof redacted === "object" && redacted !== null
      ? (redacted as Record<string, unknown>)
      : { value: redacted };
  }

  return Object.freeze({
    debug(message: string, context?: LogContext) {
      if (context) {
        logger.debug(safeContext(context), redactText(message));
      } else {
        logger.debug(redactText(message));
      }
    },
    error(message: string, context?: LogContext) {
      if (context) {
        logger.error(safeContext(context), redactText(message));
      } else {
        logger.error(redactText(message));
      }
    },
    info(message: string, context?: LogContext) {
      if (context) {
        logger.info(safeContext(context), redactText(message));
      } else {
        logger.info(redactText(message));
      }
    },
    warn(message: string, context?: LogContext) {
      if (context) {
        logger.warn(safeContext(context), redactText(message));
      } else {
        logger.warn(redactText(message));
      }
    },
  });
}
