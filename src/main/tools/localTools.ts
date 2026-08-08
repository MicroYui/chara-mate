import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { JsonValue } from "../../shared/contracts/primitives";
import type { ToolResult } from "../../shared/contracts/tool";
import { redactText } from "../../shared/pure/redaction";
import type { ArtifactStore } from "./artifactStore";
import { runProcess } from "./processRunner";
import type { ToolDefinition, ToolRegistry } from "./toolRegistry";
import { toolEvidenceHash } from "./toolRegistry";

interface LocalToolDependencies {
  readonly artifacts: ArtifactStore;
  readonly openPath: (target: string) => Promise<string>;
  readonly openUrl: (url: string) => Promise<void>;
  readonly resolvePath: (target: string) => string;
  readonly trashItem: (target: string) => Promise<void>;
}

const SEARCH_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".vite",
  "node_modules",
  "out",
  "test-results",
]);

function stringInput(
  input: Readonly<Record<string, JsonValue>>,
  name: string,
): string {
  const value = input[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  input: Readonly<Record<string, JsonValue>>,
  name: string,
): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new TypeError(`${name} must be a string`);
  return value;
}

function summaryInput(
  input: Readonly<Record<string, JsonValue>>,
  name: string,
  fallback = "",
): string {
  const value = input[name];
  return typeof value === "string" ? value : fallback;
}

function success(
  summary: string,
  modelContent: JsonValue,
  artifacts: ToolResult["artifacts"] = [],
): ToolResult {
  return {
    artifacts,
    evidenceHash: toolEvidenceHash(modelContent),
    modelContent,
    retryable: false,
    status: "success",
    summary,
  };
}

function objectSchema(
  properties: Record<string, JsonValue>,
  required: string[],
): JsonValue {
  return {
    additionalProperties: false,
    properties,
    required,
    type: "object",
  };
}

function descriptor(
  value: Omit<ToolDefinition["descriptor"], "source">,
): ToolDefinition["descriptor"] {
  return { ...value, source: "builtin" };
}

async function listDirectory(target: string): Promise<JsonValue> {
  const entries = await readdir(target, { withFileTypes: true });
  const values = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(target, entry.name);
      const metadata = await stat(fullPath);
      return {
        kind: entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : "other",
        modifiedAt: metadata.mtime.toISOString(),
        name: entry.name,
        path: fullPath,
        size: metadata.size,
      } satisfies JsonValue;
    }),
  );
  return { entries: values, path: target };
}

async function collectFiles(
  target: string,
  signal: AbortSignal,
): Promise<string[]> {
  signal.throwIfAborted();
  const metadata = await stat(target);
  if (metadata.isFile()) return [target];
  if (!metadata.isDirectory()) return [];
  const entries = await readdir(target, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    signal.throwIfAborted();
    if (entry.isSymbolicLink()) continue;
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (SEARCH_IGNORED_DIRECTORIES.has(entry.name)) continue;
      files.push(...(await collectFiles(child, signal)));
    } else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function searchText(
  target: string,
  query: string,
  signal: AbortSignal,
): Promise<string> {
  const matches: string[] = [];
  for (const filePath of await collectFiles(target, signal)) {
    signal.throwIfAborted();
    let content: string;
    try {
      content = await readFile(filePath, { encoding: "utf8", signal });
    } catch {
      continue;
    }
    if (content.includes("\0")) continue;
    for (const [index, line] of content.split(/\r?\n/u).entries()) {
      if (line.includes(query)) {
        matches.push(`${filePath}:${String(index + 1)}:${line}`);
      }
    }
  }
  return matches.join("\n");
}

function shellCommand(): { command: string; prefix: string[] } {
  return process.platform === "win32"
    ? {
        command: process.env["COMSPEC"] ?? "cmd.exe",
        prefix: ["/d", "/s", "/c"],
      }
    : { command: process.env["SHELL"] ?? "/bin/sh", prefix: ["-lc"] };
}

export function registerLocalTools(
  registry: ToolRegistry,
  dependencies: LocalToolDependencies,
): void {
  const pathProperty = {
    description: "Absolute or workspace-relative path",
    type: "string",
  };

  registry.register({
    descriptor: descriptor({
      description: "List the immediate children of a local directory.",
      effect: "read",
      idempotency: "idempotent",
      inputSchema: objectSchema({ path: pathProperty }, ["path"]),
      itemKind: "tool_call",
      name: "file.list",
      namespace: "file",
      recoveryGroup: "file.inspect",
      summary: "列出目录",
    }),
    execute: async (input) => {
      const target = dependencies.resolvePath(stringInput(input, "path"));
      const content = await listDirectory(target);
      return success(`已列出 ${target}`, content);
    },
    summarize: (input) => `列出目录 ${summaryInput(input, "path")}`,
  });

  registry.register({
    descriptor: descriptor({
      description:
        "Read a UTF-8 local file. Full large output is preserved as an artifact.",
      effect: "read",
      idempotency: "idempotent",
      inputSchema: objectSchema({ path: pathProperty }, ["path"]),
      itemKind: "tool_call",
      name: "file.read",
      namespace: "file",
      recoveryGroup: "file.inspect",
      summary: "读取文件",
    }),
    execute: async (input, context) => {
      const target = dependencies.resolvePath(stringInput(input, "path"));
      const content = redactText(await readFile(target, "utf8"));
      const presented = await dependencies.artifacts.presentText(
        context.runId,
        path.basename(target),
        content,
      );
      return success(
        `已读取 ${target}`,
        { content: presented.displayOutput, path: target },
        [...presented.artifacts],
      );
    },
    summarize: (input) => `读取文件 ${summaryInput(input, "path")}`,
  });

  registry.register({
    descriptor: descriptor({
      description:
        "Search UTF-8 local files recursively and return matching lines.",
      effect: "read",
      idempotency: "idempotent",
      inputSchema: objectSchema(
        { path: pathProperty, query: { type: "string" } },
        ["path", "query"],
      ),
      itemKind: "tool_call",
      name: "file.search",
      namespace: "file",
      recoveryGroup: "file.inspect",
      summary: "搜索文件内容",
    }),
    execute: async (input, context) => {
      const target = dependencies.resolvePath(stringInput(input, "path"));
      const query = stringInput(input, "query");
      const output = await searchText(target, query, context.signal);
      const presented = await dependencies.artifacts.presentText(
        context.runId,
        "search-results.txt",
        redactText(output),
      );
      return success(
        output ? "文件搜索完成" : "没有找到匹配内容",
        {
          output: presented.displayOutput,
          path: target,
          query,
        },
        [...presented.artifacts],
      );
    },
    summarize: (input) =>
      `在 ${summaryInput(input, "path")} 搜索 ${summaryInput(input, "query")}`,
  });

  registry.register({
    descriptor: descriptor({
      description: "Create or replace a UTF-8 local file.",
      effect: "write",
      idempotency: "idempotent",
      inputSchema: objectSchema(
        { content: { type: "string" }, path: pathProperty },
        ["path", "content"],
      ),
      itemKind: "file_change",
      name: "file.write",
      namespace: "file",
      recoveryGroup: "file.modify",
      summary: "写入文件",
    }),
    execute: async (input) => {
      const target = dependencies.resolvePath(stringInput(input, "path"));
      const content = optionalString(input, "content") ?? "";
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      const digest = createHash("sha256").update(content).digest("hex");
      return success(`已写入 ${target}`, {
        byteLength: Buffer.byteLength(content, "utf8"),
        path: target,
        sha256: digest,
      });
    },
    summarize: (input) => `写入文件 ${summaryInput(input, "path")}`,
  });

  registry.register({
    descriptor: descriptor({
      description: "Replace one exact text occurrence in a UTF-8 file.",
      effect: "write",
      idempotency: "idempotent",
      inputSchema: objectSchema(
        {
          path: pathProperty,
          replacement: { type: "string" },
          search: { type: "string" },
        },
        ["path", "search", "replacement"],
      ),
      itemKind: "file_change",
      name: "file.patch",
      namespace: "file",
      recoveryGroup: "file.modify",
      summary: "修改文件",
    }),
    execute: async (input) => {
      const target = dependencies.resolvePath(stringInput(input, "path"));
      const search = stringInput(input, "search");
      const replacement = optionalString(input, "replacement") ?? "";
      const current = await readFile(target, "utf8");
      const first = current.indexOf(search);
      if (first < 0 || current.indexOf(search, first + search.length) >= 0) {
        return {
          artifacts: [],
          error: {
            code: "TOOL.PATCH_MISMATCH",
            message: "待替换文本不存在或不唯一，未修改文件。",
            retryable: false,
          },
          modelContent: { path: target, reason: "search_not_unique" },
          retryable: false,
          status: "error",
          summary: "未修改文件",
        };
      }
      const next = `${current.slice(0, first)}${replacement}${current.slice(first + search.length)}`;
      const temporary = `${target}.charamate-${process.pid}.tmp`;
      await writeFile(temporary, next, "utf8");
      await rename(temporary, target);
      return success(`已修改 ${target}`, {
        path: target,
        sha256: createHash("sha256").update(next).digest("hex"),
      });
    },
    summarize: (input) => `修改文件 ${summaryInput(input, "path")}`,
  });

  registry.register({
    descriptor: descriptor({
      description:
        "Move a local file or directory to the operating-system trash.",
      effect: "critical",
      idempotency: "non_idempotent",
      inputSchema: objectSchema({ path: pathProperty }, ["path"]),
      itemKind: "file_change",
      name: "file.trash",
      namespace: "file",
      summary: "移到废纸篓",
    }),
    execute: async (input) => {
      const target = dependencies.resolvePath(stringInput(input, "path"));
      await dependencies.trashItem(target);
      return success(`已将 ${target} 移到废纸篓`, { path: target });
    },
    summarize: (input) => `将 ${summaryInput(input, "path")} 移到废纸篓`,
  });

  registry.register({
    descriptor: descriptor({
      description:
        "Run a shell command, stream stdout/stderr, and wait for its real exit.",
      effect: "write",
      idempotency: "non_idempotent",
      inputSchema: objectSchema(
        {
          command: { type: "string" },
          cwd: { type: "string" },
          input: { type: "string" },
        },
        ["command"],
      ),
      itemKind: "command",
      name: "command.run",
      namespace: "command",
      summary: "运行命令",
    }),
    execute: async (input, context) => {
      const command = stringInput(input, "command");
      const cwd = dependencies.resolvePath(optionalString(input, "cwd") ?? ".");
      const processInput = optionalString(input, "input");
      const shell = shellCommand();
      const result = await runProcess(
        {
          args: [...shell.prefix, command],
          command: shell.command,
          cwd,
          ...(processInput === undefined ? {} : { input: processInput }),
        },
        context.signal,
        context.onDelta,
      );
      const combined = redactText(
        [result.stdout, result.stderr].filter(Boolean).join("\n"),
      );
      const presented = await dependencies.artifacts.presentText(
        context.runId,
        "command-output.txt",
        combined,
      );
      const modelContent: JsonValue = {
        command,
        cwd,
        exitCode: result.exitCode,
        output: presented.displayOutput,
        signal: result.signal,
      };
      if (result.exitCode !== 0) {
        return {
          artifacts: [...presented.artifacts],
          error: {
            code: "TOOL.COMMAND_FAILED",
            details: modelContent,
            message: `命令退出码为 ${String(result.exitCode)}。`,
            retryable: false,
          },
          evidenceHash: toolEvidenceHash(modelContent),
          modelContent,
          retryable: false,
          status: "error",
          summary: "命令执行失败",
        };
      }
      return success("命令执行完成", modelContent, [...presented.artifacts]);
    },
    summarize: (input) => `运行命令：${summaryInput(input, "command")}`,
  });

  registry.register({
    descriptor: descriptor({
      description: "Open a URL in the user's default application.",
      effect: "write",
      idempotency: "idempotent",
      inputSchema: objectSchema({ url: { type: "string" } }, ["url"]),
      itemKind: "tool_call",
      name: "app.open_url",
      namespace: "app",
      recoveryGroup: "app.open",
      summary: "打开链接",
    }),
    execute: async (input) => {
      const url = stringInput(input, "url");
      await dependencies.openUrl(url);
      return success(`已打开 ${url}`, { url });
    },
    summarize: (input) => `打开 ${summaryInput(input, "url")}`,
  });

  registry.register({
    descriptor: descriptor({
      description:
        "Open a local file or directory in its registered application.",
      effect: "write",
      idempotency: "idempotent",
      inputSchema: objectSchema({ path: pathProperty }, ["path"]),
      itemKind: "tool_call",
      name: "app.open_path",
      namespace: "app",
      recoveryGroup: "app.open",
      summary: "打开文件",
    }),
    execute: async (input) => {
      const target = dependencies.resolvePath(stringInput(input, "path"));
      const error = await dependencies.openPath(target);
      if (error) {
        return {
          artifacts: [],
          error: {
            code: "TOOL.APP_OPEN_FAILED",
            message: error,
            retryable: false,
          },
          modelContent: { error, path: target },
          retryable: false,
          status: "error",
          summary: "无法打开文件",
        };
      }
      return success(`已打开 ${target}`, { path: target });
    },
    summarize: (input) => `打开 ${summaryInput(input, "path")}`,
  });
}
