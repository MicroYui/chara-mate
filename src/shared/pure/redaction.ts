export const REDACTED_VALUE = "[REDACTED]";

const SENSITIVE_FIELD_NAMES = new Set([
  "apikey",
  "authorization",
  "clientsecret",
  "cookie",
  "cookies",
  "credential",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "setcookie",
  "token",
  "accesstoken",
]);

const TEXT_PATTERNS: readonly [RegExp, string][] = [
  [
    /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gu,
    REDACTED_VALUE,
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, `Bearer ${REDACTED_VALUE}`],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/gu, REDACTED_VALUE],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, REDACTED_VALUE],
  [/\bAKIA[A-Z0-9]{16}\b/gu, REDACTED_VALUE],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, REDACTED_VALUE],
  [
    /\b(api[-_ ]?key|authorization|client[-_ ]?secret|cookie|password|private[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token)\s*[:=]\s*[^\s,;]+/giu,
    `$1=${REDACTED_VALUE}`,
  ],
];

function normalizeFieldName(fieldName: string): string {
  return fieldName.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

export function isSensitiveFieldName(fieldName: string): boolean {
  return SENSITIVE_FIELD_NAMES.has(normalizeFieldName(fieldName));
}

export function redactText(value: string): string {
  return TEXT_PATTERNS.reduce(
    (redacted, [pattern, replacement]) =>
      redacted.replaceAll(pattern, replacement),
    value,
  );
}

function redactUnknown(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "undefined"
  ) {
    return value;
  }
  if (typeof value === "bigint" || typeof value === "symbol") {
    return String(value);
  }
  if (typeof value === "function") {
    return "[Function omitted]";
  }
  if (ArrayBuffer.isView(value)) {
    return "[Binary omitted]";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);
  if (value instanceof Error) {
    const redactedError: Record<string, unknown> = {
      message: redactText(value.message),
      name: value.name,
    };
    if (value.stack) {
      redactedError["stack"] = redactText(value.stack);
    }
    for (const [key, nestedValue] of Object.entries(value)) {
      redactedError[key] = isSensitiveFieldName(key)
        ? REDACTED_VALUE
        : redactUnknown(nestedValue, seen);
    }
    seen.delete(value);
    return redactedError;
  }
  if (Array.isArray(value)) {
    const redactedArray = value.map((entry) => redactUnknown(entry, seen));
    seen.delete(value);
    return redactedArray;
  }

  const redactedObject: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    redactedObject[key] = isSensitiveFieldName(key)
      ? REDACTED_VALUE
      : redactUnknown(nestedValue, seen);
  }
  seen.delete(value);
  return redactedObject;
}

export function redactBoundaryValue(value: unknown): unknown {
  return redactUnknown(value, new WeakSet());
}
