import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function requestText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeSse(response: ServerResponse, events: readonly object[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) {
    const type = "type" in event ? String(event.type) : "message";
    response.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.write("data: [DONE]\n\n");
  response.end();
}

function completed(responseId: string) {
  return {
    response: {
      id: responseId,
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 40 },
        output_tokens: 10,
      },
    },
    type: "response.completed",
  };
}

function searchCall(callId: string, query: string) {
  return {
    item: {
      arguments: { limit: 8, query },
      call_id: callId,
      type: "tool_search_call",
    },
    type: "response.output_item.done",
  };
}

function functionCall(
  callId: string,
  name: string,
  namespace: string,
  arguments_: Readonly<Record<string, unknown>>,
) {
  return {
    item: {
      arguments: JSON.stringify(arguments_),
      call_id: callId,
      name,
      namespace,
      type: "function_call",
    },
    type: "response.output_item.done",
  };
}

function finalAnswer(responseId: string, text: string) {
  return [
    { delta: text, type: "response.output_text.delta" },
    completed(responseId),
  ];
}

async function startFakeProvider(browserUrl?: string) {
  const bodies: string[] = [];
  let responseSequence = 0;
  const server = createServer((request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          context_window: 1_050_000,
          id: "gpt-5.6-sol",
          max_input_tokens: 922_000,
          max_output_tokens: 128_000,
          object: "model",
        }),
      );
      return;
    }
    void requestText(request).then((body) => {
      bodies.push(body);
      responseSequence += 1;
      const responseId = `response-${String(responseSequence)}`;
      const browserTask = body.includes("浏览器");
      if (browserTask) {
        if (
          body.includes('"call_id":"browser-snapshot"') &&
          body.includes("function_call_output")
        ) {
          writeSse(response, finalAnswer(responseId, "浏览器检查完成"));
        } else if (
          body.includes('"call_id":"browser-nav"') &&
          body.includes("function_call_output")
        ) {
          writeSse(response, [
            functionCall("browser-snapshot", "browser.snapshot", "browser", {}),
            completed(responseId),
          ]);
        } else if (body.includes("tool_search_output")) {
          writeSse(response, [
            functionCall("browser-nav", "browser.navigate", "browser", {
              url: browserUrl,
            }),
            completed(responseId),
          ]);
        } else {
          writeSse(response, [
            searchCall("browser-search", "open and inspect a web page"),
            completed(responseId),
          ]);
        }
      } else if (
        body.includes('"call_id":"file-write"') &&
        body.includes("function_call_output")
      ) {
        writeSse(response, finalAnswer(responseId, "文件任务完成"));
      } else if (body.includes("tool_search_output")) {
        writeSse(response, [
          functionCall("file-write", "file.write", "file", {
            content: "created once\n",
            path: "e2e-note.txt",
          }),
          completed(responseId),
        ]);
      } else {
        writeSse(response, [
          searchCall("file-search", "create a local text file"),
          completed(responseId),
        ]);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    bodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function findWindow(
  application: ElectronApplication,
  title: string,
): Promise<Page> {
  await expect
    .poll(async () =>
      Promise.all(application.windows().map((window) => window.title())),
    )
    .toContain(title);
  for (const window of application.windows()) {
    if ((await window.title()) === title) return window;
  }
  throw new Error(`Missing Electron window: ${title}`);
}

async function launchApplication(userData: string, workspace: string) {
  const application = await electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    env: {
      ...process.env,
      CHARAMATE_DEV_DASHBOARD: "0",
      CHARAMATE_USER_DATA_DIR: userData,
      CHARAMATE_WORKSPACE_DIR: workspace,
    },
  });
  const stderr: string[] = [];
  application.process().stderr?.on("data", (chunk: Buffer | string) => {
    stderr.push(chunk.toString());
  });
  const main = await findWindow(application, "CharaMate");
  const character = await findWindow(application, "CharaMate Character");
  await expect(main.getByRole("heading", { name: "新对话" })).toBeVisible();
  return { application, character, main, stderr };
}

function expectCleanApplicationShutdown(stderr: readonly string[]): void {
  const output = stderr.join("");
  expect(output).not.toContain("database connection is not open");
  expect(output).not.toContain("UnhandledPromiseRejectionWarning");
  expect(output).not.toContain("Uncaught Exception:");
}

async function saveProvider(page: Page, baseUrl: string): Promise<void> {
  const saved = await page.evaluate(
    ({ url }) =>
      window.charaMate.provider.saveProfile({
        credential: { mode: "replace", value: "sk-agent-e2e-secret" },
        profile: {
          apiStyle: "openai-compatible",
          baseUrl: url,
          chatModel: "gpt-5.6-sol",
          name: "Agent E2E",
        },
      }),
    { url: baseUrl },
  );
  expect(saved.ok).toBe(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "gpt-5.6-sol" })).toBeVisible();
}

async function selectAgent(
  page: Page,
  approvalMode?: "完全访问",
): Promise<void> {
  await page.getByRole("button", { exact: true, name: "Chat" }).click();
  await page.getByRole("menuitem", { name: /^Agent/u }).click();
  if (approvalMode) {
    await page.getByRole("button", { name: /请求批准/u }).click();
    await page.getByRole("menuitem", { name: /完全访问/u }).click();
  }
}

test("runs one persisted Agent path with shared approval and no side-effect replay", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chara-mate-agent-e2e-"));
  const userData = path.join(root, "user-data");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const provider = await startFakeProvider();
  let application: ElectronApplication | undefined;

  try {
    const first = await launchApplication(userData, workspace);
    application = first.application;
    await saveProvider(first.main, provider.baseUrl);
    await selectAgent(first.main);
    await first.main
      .getByRole("textbox", { name: "消息" })
      .fill("创建测试文件");
    await first.main.getByRole("button", { name: "发送" }).click();

    const approval = first.main.getByLabel("需要你的确认");
    await expect(approval).toBeVisible();
    await expect(approval).toContainText("写入文件 e2e-note.txt");
    await expect(first.character.getByLabel("桌宠审批提醒")).toContainText(
      "写入文件 e2e-note.txt",
    );
    await expect(
      access(path.join(workspace, "e2e-note.txt")),
    ).rejects.toThrow();

    await first.character.getByRole("button", { name: "允许" }).click();
    await expect(first.main.getByText("文件任务完成")).toBeVisible();
    await expect(first.character.getByLabel("桌宠审批提醒")).toHaveCount(0);
    expect(await readFile(path.join(workspace, "e2e-note.txt"), "utf8")).toBe(
      "created once\n",
    );

    const completedRun = first.main.getByRole("button", { name: /已处理/u });
    await completedRun.click();
    await expect(first.main.getByText("已允许一次")).toBeVisible();
    const state = await first.main.evaluate(async () => {
      const chats = await window.charaMate.chat.list({ status: "active" });
      if (!chats.ok || !chats.value[0]) return null;
      return window.charaMate.chat.getSnapshot({ chatId: chats.value[0].id });
    });
    expect(state).not.toBeNull();
    if (!state?.ok || !state.value) throw new Error("Missing Agent E2E state");
    expect(state.value.approvals).toHaveLength(1);
    expect(state.value.runs).toHaveLength(1);
    expect(state.value.runs[0]?.status).toBe("completed");
    expect(
      state.value.runItems.filter(({ kind }) => kind === "file_change"),
    ).toHaveLength(1);
    const requestCount = provider.bodies.length;

    await application.close();
    application = undefined;
    expectCleanApplicationShutdown(first.stderr);
    const second = await launchApplication(userData, workspace);
    application = second.application;
    await expect(second.main.getByText("文件任务完成")).toBeVisible();
    expect(provider.bodies).toHaveLength(requestCount);
    expect(await readFile(path.join(workspace, "e2e-note.txt"), "utf8")).toBe(
      "created once\n",
    );
    await application.close();
    application = undefined;
    expectCleanApplicationShutdown(second.stderr);

    const database = new Database(path.join(userData, "charamate.sqlite"), {
      readonly: true,
    });
    const checkpointCount = database
      .prepare("SELECT COUNT(*) AS count FROM checkpoints")
      .get() as { count: number };
    database.close();
    expect(checkpointCount.count).toBe(0);
  } finally {
    await application?.close();
    await provider.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("operates the product-managed Chromium through the same Agent Runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chara-mate-browser-e2e-"));
  const userData = path.join(root, "user-data");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  let visited = false;
  const targetServer = createServer((_request, response) => {
    visited = true;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><title>Browser E2E</title><h1>Browser E2E</h1><button>Continue</button>",
    );
  });
  await new Promise<void>((resolve, reject) => {
    targetServer.once("error", reject);
    targetServer.listen(0, "127.0.0.1", resolve);
  });
  const address = targetServer.address() as AddressInfo;
  const targetUrl = `http://127.0.0.1:${String(address.port)}`;
  const provider = await startFakeProvider(targetUrl);
  let application: ElectronApplication | undefined;

  try {
    const launched = await launchApplication(userData, workspace);
    application = launched.application;
    await saveProvider(launched.main, provider.baseUrl);
    await selectAgent(launched.main, "完全访问");
    await launched.main
      .getByRole("textbox", { name: "消息" })
      .fill("用浏览器检查测试页面");
    await launched.main.getByRole("button", { name: "发送" }).click();

    await expect(launched.main.getByText("浏览器检查完成")).toBeVisible();
    expect(visited).toBe(true);
    expect(provider.bodies.some((body) => body.includes("Browser E2E"))).toBe(
      true,
    );
    const completedRun = launched.main.getByRole("button", { name: /已处理/u });
    await completedRun.click();
    await expect(launched.main.getByText("已调用工具")).toHaveCount(2);
    expect(
      await readdir(path.join(userData, "browser", "profile")),
    ).not.toHaveLength(0);
    await application.close();
    application = undefined;
    expectCleanApplicationShutdown(launched.stderr);
  } finally {
    await application?.close();
    await provider.close();
    await new Promise<void>((resolve) => {
      targetServer.closeAllConnections();
      targetServer.close(() => resolve());
    });
    await rm(root, { force: true, recursive: true });
  }
});
