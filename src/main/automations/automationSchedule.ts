import { CronExpressionParser } from "cron-parser";

import type {
  AutomationDefinition,
  AutomationSchedule,
} from "../../shared/contracts/automation";
import type { Timestamp } from "../../shared/contracts/primitives";
import { AutomationDefinitionSchema } from "../../shared/schemas/automation";
import { parseSchema } from "../../shared/schemas/validation";
import { AutomationError } from "./automationError";

interface CronFieldRule {
  readonly label: string;
  readonly maximum: number;
  readonly minimum: number;
}

const POSIX_FIELD_RULES: readonly CronFieldRule[] = [
  { label: "minute", maximum: 59, minimum: 0 },
  { label: "hour", maximum: 23, minimum: 0 },
  { label: "day-of-month", maximum: 31, minimum: 1 },
  { label: "month", maximum: 12, minimum: 1 },
  { label: "day-of-week", maximum: 6, minimum: 0 },
];

function invalidSchedule(message: string): never {
  throw new AutomationError("AUTOMATION.INVALID_SCHEDULE", message, false);
}

function validateInteger(source: string, rule: CronFieldRule): number {
  if (!/^\d+$/u.test(source)) {
    invalidSchedule(`Cron ${rule.label} 字段只接受整数、范围、列表或 *。`);
  }
  const value = Number(source);
  if (value < rule.minimum || value > rule.maximum) {
    invalidSchedule(
      `Cron ${rule.label} 字段必须在 ${rule.minimum}–${rule.maximum} 之间。`,
    );
  }
  return value;
}

function validateCronField(source: string, rule: CronFieldRule): void {
  if (source === "*") return;
  for (const part of source.split(",")) {
    if (!part) {
      invalidSchedule(`Cron ${rule.label} 列表包含空项。`);
    }
    const range = part.split("-");
    if (range.length === 1) {
      validateInteger(range[0]!, rule);
      continue;
    }
    if (range.length !== 2 || !range[0] || !range[1]) {
      invalidSchedule(`Cron ${rule.label} 范围格式无效。`);
    }
    const start = validateInteger(range[0], rule);
    const end = validateInteger(range[1], rule);
    if (start > end) {
      invalidSchedule(`Cron ${rule.label} 范围起点不能晚于终点。`);
    }
  }
}

export function validatePosixCronExpression(expression: string): string {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== POSIX_FIELD_RULES.length) {
    invalidSchedule("Cron 必须恰好包含五个 POSIX 调度字段。");
  }
  fields.forEach((field, index) =>
    validateCronField(field, POSIX_FIELD_RULES[index]!),
  );
  return fields.join(" ");
}

function recurringExpression(schedule: AutomationSchedule): {
  readonly expression: string;
  readonly timeZone: string;
} {
  if (schedule.kind === "daily") {
    const [hour, minute] = schedule.localTime.split(":");
    return {
      expression: `${Number(minute)} ${Number(hour)} * * *`,
      timeZone: schedule.timeZone,
    };
  }
  if (schedule.kind === "weekly") {
    const [hour, minute] = schedule.localTime.split(":");
    const weekdays = schedule.weekdays
      .map((weekday) => (weekday === 7 ? 0 : weekday))
      .sort((left, right) => left - right)
      .join(",");
    return {
      expression: `${Number(minute)} ${Number(hour)} * * ${weekdays}`,
      timeZone: schedule.timeZone,
    };
  }
  if (schedule.kind === "cron") {
    return {
      expression: validatePosixCronExpression(schedule.expression),
      timeZone: schedule.timeZone,
    };
  }
  invalidSchedule("一次性计划没有重复表达式。");
}

export function nextAutomationOccurrence(
  schedule: AutomationSchedule,
  after: Timestamp,
): Timestamp | undefined {
  if (schedule.kind === "once") {
    return Date.parse(schedule.runAt) > Date.parse(after)
      ? schedule.runAt
      : undefined;
  }

  try {
    const { expression, timeZone } = recurringExpression(schedule);
    return CronExpressionParser.parse(expression, {
      currentDate: after,
      tz: timeZone,
    })
      .next()
      .toDate()
      .toISOString();
  } catch (error) {
    if (error instanceof AutomationError) throw error;
    invalidSchedule(
      error instanceof Error
        ? `无法计算这个计划：${error.message}`
        : "无法计算这个计划。",
    );
  }
}

export function validateAutomationDefinition(
  input: AutomationDefinition,
  after: Timestamp,
): {
  readonly definition: AutomationDefinition;
  readonly nextRunAt: Timestamp;
} {
  const definition = parseSchema(AutomationDefinitionSchema, input);
  const nextRunAt = nextAutomationOccurrence(definition.schedule, after);
  if (!nextRunAt) {
    invalidSchedule("一次性任务的运行时间必须晚于当前操作时间。");
  }
  return { definition, nextRunAt };
}
