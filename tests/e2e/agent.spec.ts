import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
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
import { createPng } from "../fixtures/png";

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
  let releasePlanProgress: () => void = () => undefined;
  let releasePlanFinal: () => void = () => undefined;
  const planProgressGate = new Promise<void>((resolve) => {
    releasePlanProgress = resolve;
  });
  const planFinalGate = new Promise<void>((resolve) => {
    releasePlanFinal = resolve;
  });
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
    void requestText(request).then(async (body) => {
      bodies.push(body);
      responseSequence += 1;
      const responseId = `response-${String(responseSequence)}`;
      const titleTask = body.includes("Generate one concise chat title");
      const browserTask = body.includes("浏览器");
      const collaborationChild = body.includes(
        "read-only child of CharaMate's current Agent Run",
      );
      const collaborationTask = body.includes("并行协作测试");
      const imageInputTask = body.includes("图片输入测试");
      const imageToolTask = body.includes("图片工具测试");
      const memoryFormationTask = body.includes("记忆形成测试");
      const memoryRecallTask = body.includes("记忆复用测试");
      const memoryUpdateTask = body.includes("记忆更新测试");
      const planTask = body.includes("计划测试");
      const structuredInputTask = body.includes("结构化输入测试");
      const territoryTask = body.includes("Agent 端到端验收");
      if (titleTask) {
        writeSse(response, finalAnswer(responseId, "E2E 对话标题"));
      } else if (collaborationChild) {
        writeSse(
          response,
          finalAnswer(
            responseId,
            body.includes('\\"goal\\":\\"分析资源 A\\"')
              ? "子任务 A 已核对 alpha 证据"
              : "子任务 B 已核对 beta 证据",
          ),
        );
      } else if (collaborationTask) {
        if (
          body.includes('"call_id":"collaboration-e2e"') &&
          body.includes("function_call_output")
        ) {
          writeSse(
            response,
            finalAnswer(responseId, "父 Agent 已合并两个子任务"),
          );
        } else if (body.includes("tool_search_output")) {
          writeSse(response, [
            functionCall(
              "collaboration-e2e",
              "dispatch",
              "charamate_collaboration",
              {
                subtasks: [
                  {
                    goal: "分析资源 A",
                    id: "resource_a",
                    reads: [
                      {
                        input: { path: "collaboration-a.txt" },
                        resourceClaim: "file:collaboration-a.txt",
                        toolName: "file.read",
                      },
                    ],
                    resourceClaims: ["file:collaboration-a.txt"],
                  },
                  {
                    goal: "分析资源 B",
                    id: "resource_b",
                    reads: [
                      {
                        input: { path: "collaboration-b.txt" },
                        resourceClaim: "file:collaboration-b.txt",
                        toolName: "file.read",
                      },
                    ],
                    resourceClaims: ["file:collaboration-b.txt"],
                  },
                ],
              },
            ),
            completed(responseId),
          ]);
        } else {
          writeSse(response, [
            searchCall(
              "collaboration-search",
              "read two independent local files with collaboration",
            ),
            completed(responseId),
          ]);
        }
      } else if (imageInputTask) {
        writeSse(response, finalAnswer(responseId, "已读取本地图片像素"));
      } else if (imageToolTask) {
        if (
          body.includes('"call_id":"image-inspect"') &&
          body.includes("function_call_output")
        ) {
          writeSse(response, finalAnswer(responseId, "图片工具读取完成"));
        } else {
          writeSse(response, [
            functionCall("image-inspect", "image.inspect", "image", {
              path: "inspect.png",
            }),
            completed(responseId),
          ]);
        }
      } else if (memoryUpdateTask) {
        if (
          body.includes('"call_id":"memory-replace"') &&
          body.includes("function_call_output")
        ) {
          writeSse(response, finalAnswer(responseId, "已把爱好更新为游泳。"));
        } else {
          const memoryId = body.match(
            /\[memory:([0-9a-f]{8}-[0-9a-f-]{27})\s/iu,
          )?.[1];
          writeSse(response, [
            functionCall("memory-replace", "record", "memory", {
              basis: "explicit_user_statement",
              claimSlot: "preference.hobbies",
              content: "用户现在的爱好是游泳。",
              ...(memoryId ? { memoryId } : {}),
              operation: "replace",
            }),
            completed(responseId),
          ]);
        }
      } else if (memoryFormationTask) {
        if (
          body.includes('"call_id":"memory-record"') &&
          body.includes("function_call_output")
        ) {
          writeSse(response, finalAnswer(responseId, "我会记住你喜欢徒步。"));
        } else {
          writeSse(response, [
            functionCall("memory-record", "record", "memory", {
              basis: "explicit_user_statement",
              claimSlot: "preference.hobbies",
              content: "用户的爱好是徒步。",
              operation: "create",
            }),
            completed(responseId),
          ]);
        }
      } else if (memoryRecallTask) {
        writeSse(response, finalAnswer(responseId, "你现在的爱好是游泳。"));
      } else if (structuredInputTask) {
        if (
          body.includes('"call_id":"input-request"') &&
          body.includes("function_call_output")
        ) {
          writeSse(response, finalAnswer(responseId, "已按安静路线继续"));
        } else {
          writeSse(response, [
            functionCall("input-request", "request_user_input", "interaction", {
              questions: [
                {
                  header: "路线",
                  id: "route",
                  options: [
                    {
                      description: "减少排队和噪音。",
                      label: "安静路线",
                    },
                    {
                      description: "优先热门景点。",
                      label: "热门路线",
                    },
                  ],
                  question: "请选择路线偏好",
                },
              ],
            }),
            completed(responseId),
          ]);
        }
      } else if (territoryTask) {
        if (
          body.includes('"call_id":"territory-generate"') &&
          body.includes("function_call_output")
        ) {
          writeSse(response, finalAnswer(responseId, "领地候选已生成"));
        } else if (body.includes("tool_search_output")) {
          writeSse(response, [
            functionCall("territory-generate", "generate_item", "territory", {
              description: "纪念完成一次完整的 Agent 领地生成。",
              name: "Agent 纪念灯",
              structure: {
                depthAnchorPx: { x: 72, y: 120 },
                footprintTiles: { height: 2, width: 3 },
                surfaceSlots: [
                  {
                    anchorPx: { x: 72, y: 54 },
                    id: "center",
                    maxItemSizePx: { height: 32, width: 32 },
                  },
                ],
                visualSizePx: { height: 120, width: 144 },
              },
              visualPrompt: "一盏小巧的深蓝黄铜像素工坊灯",
            }),
            completed(responseId),
          ]);
        } else {
          writeSse(response, [
            searchCall(
              "territory-search",
              "generate a Territory item candidate",
            ),
            completed(responseId),
          ]);
        }
      } else if (planTask) {
        if (
          body.includes('"call_id":"plan-final"') &&
          body.includes("function_call_output")
        ) {
          writeSse(response, finalAnswer(responseId, "计划测试完成"));
        } else if (
          body.includes('"call_id":"plan-progress"') &&
          body.includes("function_call_output")
        ) {
          await planFinalGate;
          writeSse(response, [
            functionCall("plan-final", "plan.update", "plan", {
              explanation: "实现与验证均已完成。",
              plan: [
                { status: "completed", step: "检查需求" },
                { status: "completed", step: "实现计划能力" },
                { status: "completed", step: "验证界面更新" },
              ],
            }),
            completed(responseId),
          ]);
        } else if (
          body.includes('"call_id":"plan-first"') &&
          body.includes("function_call_output")
        ) {
          await planProgressGate;
          writeSse(response, [
            functionCall("plan-progress", "plan.update", "plan", {
              explanation: "需求已确认，正在验证界面。",
              plan: [
                { status: "completed", step: "检查需求" },
                { status: "completed", step: "实现计划能力" },
                { status: "in_progress", step: "验证界面更新" },
              ],
            }),
            completed(responseId),
          ]);
        } else {
          writeSse(response, [
            functionCall("plan-first", "plan.update", "plan", {
              explanation: "先检查需求，再实现并验证。",
              plan: [
                { status: "in_progress", step: "检查需求" },
                { status: "pending", step: "实现计划能力" },
                { status: "pending", step: "验证界面更新" },
              ],
            }),
            completed(responseId),
          ]);
        }
      } else if (browserTask) {
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
    close: () => {
      releasePlanProgress();
      releasePlanFinal();
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
    releasePlanFinal,
    releasePlanProgress,
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

async function launchApplication(
  userData: string,
  workspace: string,
  expectedHeading = "新对话",
) {
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
  await expect(
    main.getByRole("heading", { name: expectedHeading }),
  ).toBeVisible();
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
    expect(provider.bodies[0]).toContain('"name":"charamate_territory"');
    expect(provider.bodies[0]).toContain('"name":"generate_item"');
    expect(provider.bodies[0]).toContain('"defer_loading":true');
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
    const second = await launchApplication(userData, workspace, "E2E 对话标题");
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

test("lets the Agent choose collaboration and renders one joined Subtask Item", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-collaboration-e2e-"),
  );
  const userData = path.join(root, "user-data");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(workspace, "collaboration-a.txt"),
    "alpha 证据",
    "utf8",
  );
  await writeFile(
    path.join(workspace, "collaboration-b.txt"),
    "beta 证据",
    "utf8",
  );
  const provider = await startFakeProvider();
  let application: ElectronApplication | undefined;

  try {
    const launched = await launchApplication(userData, workspace);
    application = launched.application;
    await saveProvider(launched.main, provider.baseUrl);
    await selectAgent(launched.main, "完全访问");
    await expect(
      launched.main.getByRole("button", { name: /并行协作/u }),
    ).toHaveCount(0);
    await launched.main
      .getByRole("textbox", { name: "消息" })
      .fill("并行协作测试：比较两个独立文件");
    await launched.main.getByRole("button", { name: "发送" }).click();

    await expect(
      launched.main.getByText("父 Agent 已合并两个子任务"),
    ).toBeVisible();
    const completedRun = launched.main.getByRole("button", { name: /已处理/u });
    await completedRun.click();
    const subtask = launched.main.getByRole("button", {
      name: /已完成并行协作/u,
    });
    await expect(subtask).toBeVisible();
    await subtask.click();
    await expect(
      launched.main.getByText(/子任务 A 已核对 alpha 证据/u),
    ).toBeVisible();
    await expect(
      launched.main.getByText(/子任务 B 已核对 beta 证据/u),
    ).toBeVisible();

    const state = await launched.main.evaluate(async () => {
      const chats = await window.charaMate.chat.list({ status: "active" });
      if (!chats.ok || !chats.value[0]) return null;
      return window.charaMate.chat.getSnapshot({ chatId: chats.value[0].id });
    });
    if (!state?.ok || !state.value) {
      throw new Error("Missing collaboration E2E state");
    }
    expect(
      state.value.runItems.filter(({ kind }) => kind === "subtask"),
    ).toEqual([expect.objectContaining({ status: "completed" })]);
    expect(
      provider.bodies.filter((body) =>
        body.includes("read-only child of CharaMate's current Agent Run"),
      ),
    ).toHaveLength(2);
    expect(provider.bodies[0]).toContain('"name":"charamate_collaboration"');
    expect(provider.bodies[0]).toContain('"name":"dispatch"');
    expect(provider.bodies[0]).toContain('"defer_loading":false');
    const collaborationContinuation = provider.bodies.find((body) =>
      body.includes('"call_id":"collaboration-search"'),
    );
    expect(collaborationContinuation).toContain('"type":"tool_search_output"');
    expect(collaborationContinuation).toContain('"name":"charamate_file"');
    expect(collaborationContinuation).toContain('"name":"read"');
    expect(collaborationContinuation).not.toContain('"name":"file"');
    expect(collaborationContinuation).not.toContain('"name":"file.read"');

    await application.close();
    application = undefined;
    expectCleanApplicationShutdown(launched.stderr);
  } finally {
    await application?.close();
    await provider.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("generates a structured Territory candidate through the Agent Tool", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-agent-territory-e2e-"),
  );
  const userData = path.join(root, "user-data");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const image = createPng(16, 16, (x, y) =>
    x >= 5 && x <= 10 && y >= 4 && y <= 11
      ? [45, 93, 164, 255]
      : [255, 0, 255, 255],
  );
  let imageRequests = 0;
  const imageServer = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    expect(request.headers["api-key"]).toBe("agent-territory-image-key");
    expect(requestUrl.pathname).toContain("/images/generations");
    request.resume();
    request.on("end", () => {
      imageRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ data: [{ b64_json: image.toString("base64") }] }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    imageServer.once("error", reject);
    imageServer.listen(0, "127.0.0.1", resolve);
  });
  const imageAddress = imageServer.address() as AddressInfo;
  const imageBaseUrl = `http://127.0.0.1:${String(imageAddress.port)}`;
  const provider = await startFakeProvider();
  let application: ElectronApplication | undefined;

  try {
    const launched = await launchApplication(userData, workspace);
    application = launched.application;
    await saveProvider(launched.main, provider.baseUrl);
    const prepared = await launched.main.evaluate(
      async ({ baseUrl }) => {
        const saved = await window.charaMate.provider.saveProfile({
          credential: { mode: "replace", value: "agent-territory-image-key" },
          profile: {
            apiStyle: "azure-openai",
            apiVersion: "2025-04-01-preview",
            baseUrl,
            imageGenerationEndpoint: `${baseUrl}/openai/deployments/gpt-image-2/images/generations?api-version=2025-04-01-preview`,
            imageModel: "gpt-image-2",
            name: "Agent Territory Image",
          },
        });
        const scene = await window.charaMate.territory.selectScene({
          sceneId: "star-workshop",
        });
        return { saved, scene };
      },
      { baseUrl: imageBaseUrl },
    );
    expect(prepared.saved).toMatchObject({ ok: true });
    expect(prepared.scene).toMatchObject({ ok: true });

    await selectAgent(launched.main, "完全访问");
    await launched.main
      .getByRole("textbox", { name: "消息" })
      .fill("生成一个领地物件来纪念这次 Agent 端到端验收");
    await launched.main.getByRole("button", { name: "发送" }).click();

    await expect(launched.main.getByText("领地候选已生成")).toBeVisible();
    const snapshot = await launched.main.evaluate(async () => {
      const response = await window.charaMate.territory.getSnapshot();
      return response.ok ? response.value : null;
    });
    expect(snapshot?.imageCandidates[0]).toMatchObject({
      name: "Agent 纪念灯",
      status: "ready",
      structure: {
        footprintTiles: { height: 2, width: 3 },
        surfaceSlots: [{ id: "center" }],
        visualSizePx: { height: 120, width: 144 },
      },
    });
    expect(snapshot?.collection).toHaveLength(3);
    expect(imageRequests).toBe(1);
    expect(
      provider.bodies.some((body) => body.includes("awaiting_confirmation")),
    ).toBe(true);

    await launched.main.getByRole("button", { name: "Territory" }).click();
    await expect(launched.main.getByTestId("territory-canvas")).toBeVisible();
    await launched.main.getByRole("button", { name: "生成物件" }).click();
    await expect(
      launched.main.getByRole("img", { name: "Agent 纪念灯预览" }),
    ).toBeVisible();

    await application.close();
    application = undefined;
    expectCleanApplicationShutdown(launched.stderr);
  } finally {
    await application?.close();
    await provider.close();
    await new Promise<void>((resolve) => {
      imageServer.closeAllConnections();
      imageServer.close(() => resolve());
    });
    await rm(root, { force: true, recursive: true });
  }
});

test("answers a direct structured question and continues the same Chat Run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chara-mate-input-e2e-"));
  const userData = path.join(root, "user-data");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const provider = await startFakeProvider();
  let application: ElectronApplication | undefined;

  try {
    const launched = await launchApplication(userData, workspace);
    application = launched.application;
    await saveProvider(launched.main, provider.baseUrl);
    await launched.main
      .getByRole("textbox", { name: "消息" })
      .fill("结构化输入测试：先问我路线偏好再继续");
    await launched.main.getByRole("button", { name: "发送" }).click();

    const request = launched.main.getByLabel("需要补充信息");
    await expect(request).toBeVisible();
    await expect(request).toContainText("请选择路线偏好");
    expect(provider.bodies).toHaveLength(1);
    expect(provider.bodies[0]).toContain('"name":"charamate_interaction"');
    expect(provider.bodies[0]).toContain('"name":"request_user_input"');
    expect(provider.bodies[0]).toContain('"defer_loading":false');
    expect(provider.bodies[0]).not.toContain("tool_search_output");

    await request.getByRole("radio", { name: /安静路线/u }).click();
    await request.getByRole("button", { name: "提交并继续" }).click();
    await expect(launched.main.getByText("已按安静路线继续")).toBeVisible();

    const state = await launched.main.evaluate(async () => {
      const chats = await window.charaMate.chat.list({ status: "active" });
      if (!chats.ok || !chats.value[0]) return null;
      return window.charaMate.chat.getSnapshot({ chatId: chats.value[0].id });
    });
    if (!state?.ok || !state.value) {
      throw new Error("Missing structured input E2E state");
    }
    expect(state.value.runs).toHaveLength(1);
    expect(state.value.runs[0]?.status).toBe("completed");
    const inputItems = state.value.runItems.filter(
      ({ kind }) => kind === "input_request",
    );
    expect(inputItems).toHaveLength(1);
    expect(inputItems[0]).toMatchObject({
      output: {
        answers: [
          {
            questionId: "route",
            value: { kind: "option", label: "安静路线" },
          },
        ],
        status: "answered",
      },
      status: "completed",
    });
    const taskBodies = provider.bodies.filter(
      (body) => !body.includes("Generate one concise chat title"),
    );
    expect(taskBodies).toHaveLength(2);
    expect(taskBodies[1]?.match(/input-request/gu)).toHaveLength(2);

    await application.close();
    application = undefined;
    expectCleanApplicationShutdown(launched.stderr);
  } finally {
    await application?.close();
    await provider.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("updates one stable Memory across Chats without leaving conflicting active facts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chara-mate-memory-e2e-"));
  const userData = path.join(root, "user-data");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const provider = await startFakeProvider();
  let application: ElectronApplication | undefined;

  try {
    const launched = await launchApplication(userData, workspace);
    application = launched.application;
    await saveProvider(launched.main, provider.baseUrl);
    const sendMessage = async (content: string) => {
      await launched.main.getByRole("textbox", { name: "消息" }).fill(content);
      await launched.main.getByRole("button", { name: "发送" }).click();
    };

    await sendMessage("记忆形成测试：我的爱好是徒步。");
    await expect(launched.main.getByText("我会记住你喜欢徒步。")).toBeVisible();
    await launched.main.getByRole("button", { name: "新建对话" }).click();
    await sendMessage("记忆更新测试：我现在不再喜欢徒步，爱好改成游泳。");
    await expect(launched.main.getByText("已把爱好更新为游泳。")).toBeVisible();
    await launched.main.getByRole("button", { name: "新建对话" }).click();
    await sendMessage("记忆复用测试：我的爱好是什么？");
    await expect(launched.main.getByText("你现在的爱好是游泳。")).toBeVisible();

    const taskBodies = provider.bodies.filter(
      (body) => !body.includes("Generate one concise chat title"),
    );
    expect(taskBodies).toHaveLength(5);
    expect(taskBodies[0]).toContain('"name":"charamate_memory"');
    expect(taskBodies[0]).toContain('"name":"record"');
    expect(taskBodies[0]).toContain('"defer_loading":false');
    expect(taskBodies[0]).toContain('"type":"tool_search"');
    expect(taskBodies[0]).toContain('"type":"web_search"');
    expect(taskBodies[2]).toContain("Relevant long-term memories");
    expect(taskBodies[2]).toContain("stableClaimSlot: preference.hobbies");
    expect(taskBodies[2]).toContain("用户的爱好是徒步。");
    expect(taskBodies[4]).toContain("用户现在的爱好是游泳。");
    expect(taskBodies[4]).not.toContain("用户的爱好是徒步。");

    const snapshot = await launched.main.evaluate(async () =>
      window.charaMate.memory.list({ query: "爱好" }),
    );
    if (!snapshot.ok) throw new Error("Missing automatic Memory snapshot");
    expect(snapshot.value.memories).toHaveLength(1);
    expect(snapshot.value.memories[0]?.revision.content).toBe(
      "用户现在的爱好是游泳。",
    );
    expect(snapshot.value.memories[0]?.memory.claimSlot).toBe(
      "preference.hobbies",
    );
    expect(snapshot.value.memories[0]?.sources).toEqual([
      expect.objectContaining({ type: "chat" }),
    ]);

    await launched.main.getByRole("button", { name: "Memory" }).click();
    const memoryRow = launched.main.getByRole("button", {
      name: /用户现在的爱好是游泳/u,
    });
    await expect(memoryRow).toBeVisible();
    await memoryRow.click();
    await expect(
      launched.main.getByRole("heading", { name: "当前 Revision 来源" }),
    ).toBeVisible();
    await expect(
      launched.main.getByRole("button", { name: /^Chat 用户消息/u }),
    ).toBeVisible();

    await application.close();
    application = undefined;
    expectCleanApplicationShutdown(launched.stderr);

    const database = new Database(path.join(userData, "charamate.sqlite"), {
      readonly: true,
    });
    const counts = database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM memories) AS memories,
           (SELECT COUNT(*) FROM memory_revisions) AS revisions,
           (SELECT COUNT(*) FROM memory_claims) AS claims,
           (SELECT COUNT(*) FROM memory_candidates) AS candidates,
           (SELECT COUNT(*) FROM run_items WHERE kind = 'tool_call') AS toolCalls`,
      )
      .get() as {
      candidates: number;
      claims: number;
      memories: number;
      revisions: number;
      toolCalls: number;
    };
    database.close();
    expect(counts).toEqual({
      candidates: 0,
      claims: 1,
      memories: 1,
      revisions: 2,
      toolCalls: 2,
    });
  } finally {
    await application?.close();
    await provider.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("sends a local image as Provider image content from the Chat composer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chara-mate-image-e2e-"));
  const userData = path.join(root, "user-data");
  const workspace = path.join(root, "workspace");
  const imagePath = path.join(workspace, "pixel.png");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    imagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const provider = await startFakeProvider();
  let application: ElectronApplication | undefined;

  try {
    const launched = await launchApplication(userData, workspace);
    application = launched.application;
    await saveProvider(launched.main, provider.baseUrl);
    await launched.main
      .locator('input[type="file"][accept="image/*"]')
      .setInputFiles(imagePath);
    await expect(launched.main.getByLabel("待发送附件")).toContainText(
      "pixel.png",
    );
    await launched.main
      .getByRole("textbox", { name: "消息" })
      .fill("图片输入测试：读取这张图的真实像素");
    await launched.main.getByRole("button", { name: "发送" }).click();

    await expect(launched.main.getByText("已读取本地图片像素")).toBeVisible();
    const taskBodies = provider.bodies.filter(
      (body) => !body.includes("Generate one concise chat title"),
    );
    expect(taskBodies).toHaveLength(1);
    expect(taskBodies[0]).toContain('"type":"input_image"');
    expect(taskBodies[0]).toContain("data:image/png;base64,");
    expect(taskBodies[0]).not.toContain(imagePath);

    const state = await launched.main.evaluate(async () => {
      const chats = await window.charaMate.chat.list({ status: "active" });
      if (!chats.ok || !chats.value[0]) return null;
      return window.charaMate.chat.getSnapshot({ chatId: chats.value[0].id });
    });
    if (!state?.ok || !state.value) {
      throw new Error("Missing image input E2E state");
    }
    expect(state.value.attachments).toHaveLength(1);
    expect(state.value.attachments[0]).toMatchObject({
      displayName: "pixel.png",
      kind: "image",
      mediaType: "image/png",
    });

    await application.close();
    application = undefined;
    expectCleanApplicationShutdown(launched.stderr);
  } finally {
    await application?.close();
    await provider.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("loads a known local image through image.inspect in Agent mode", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-image-tool-e2e-"),
  );
  const userData = path.join(root, "user-data");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(workspace, "inspect.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const provider = await startFakeProvider();
  let application: ElectronApplication | undefined;

  try {
    const launched = await launchApplication(userData, workspace);
    application = launched.application;
    await saveProvider(launched.main, provider.baseUrl);
    await selectAgent(launched.main);
    await launched.main
      .getByRole("textbox", { name: "消息" })
      .fill("图片工具测试：读取工作目录中的 inspect.png");
    await launched.main.getByRole("button", { name: "发送" }).click();

    await expect(launched.main.getByText("图片工具读取完成")).toBeVisible();
    const taskBodies = provider.bodies.filter(
      (body) => !body.includes("Generate one concise chat title"),
    );
    expect(taskBodies).toHaveLength(2);
    const initialRequest = JSON.parse(taskBodies[0]!) as {
      tools?: Array<{
        name?: string;
        tools?: Array<{ defer_loading?: boolean; name?: string }>;
      }>;
    };
    const imageNamespace = initialRequest.tools?.find(
      ({ name }) => name === "charamate_image",
    );
    expect(imageNamespace?.tools).toContainEqual(
      expect.objectContaining({ defer_loading: false, name: "inspect" }),
    );
    expect(taskBodies[1]).toContain('"type":"input_image"');
    expect(taskBodies[1]).toContain("data:image/png;base64,");

    const state = await launched.main.evaluate(async () => {
      const chats = await window.charaMate.chat.list({ status: "active" });
      if (!chats.ok || !chats.value[0]) return null;
      return window.charaMate.chat.getSnapshot({ chatId: chats.value[0].id });
    });
    if (!state?.ok || !state.value) {
      throw new Error("Missing image Tool E2E state");
    }
    expect(
      state.value.runItems.find(
        ({ input, kind }) =>
          kind === "tool_call" &&
          typeof input === "object" &&
          input !== null &&
          !Array.isArray(input) &&
          input["toolName"] === "image.inspect",
      ),
    ).toMatchObject({
      displayOutput: "1 × 1 · image/png",
      status: "completed",
    });

    await application.close();
    application = undefined;
    expectCleanApplicationShutdown(launched.stderr);
  } finally {
    await application?.close();
    await provider.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("steers an active Run while plan.update snapshots render live", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chara-mate-plan-e2e-"));
  const userData = path.join(root, "user-data");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const provider = await startFakeProvider();
  let application: ElectronApplication | undefined;

  try {
    const launched = await launchApplication(userData, workspace);
    application = launched.application;
    await saveProvider(launched.main, provider.baseUrl);
    await selectAgent(launched.main, "完全访问");
    const composer = launched.main.getByRole("textbox", { name: "消息" });
    await composer.fill("计划测试：分步骤完成这个任务");
    await launched.main.getByRole("button", { name: "发送" }).click();

    const activePlan = launched.main.getByLabel("活跃计划");
    const planTrigger = activePlan.getByRole("button");
    await expect(planTrigger).toHaveAccessibleName("计划 1/3");
    const plan = launched.main.getByLabel("当前计划");
    await expect(plan).toHaveAttribute("aria-hidden", "true");
    await planTrigger.hover();
    await expect(plan).toBeVisible();
    await expect(plan).toContainText("先检查需求，再实现并验证。");
    expect(provider.bodies[0]).toContain('"name":"charamate_plan"');
    expect(provider.bodies[0]).toContain('"defer_loading":false');
    expect(provider.bodies[0]).toContain(
      "call the always-loaded plan.update tool directly before other work",
    );
    await expect(plan.locator("li", { hasText: "检查需求" })).toHaveAttribute(
      "data-status",
      "in_progress",
    );

    await composer.fill("追加要求：验证时保留当前界面状态");
    await expect(
      launched.main.getByRole("button", { name: "发送追加消息" }),
    ).toBeVisible();
    await launched.main.getByRole("button", { name: "发送追加消息" }).click();
    await expect(composer).toHaveValue("");

    provider.releasePlanProgress();
    await expect(planTrigger).toHaveAccessibleName("计划 3/3");
    await planTrigger.hover();
    await expect(plan).toBeVisible();
    await expect(plan).toContainText("需求已确认，正在验证界面。");
    await expect(plan.locator("li", { hasText: "检查需求" })).toHaveAttribute(
      "data-status",
      "completed",
    );
    await expect(
      plan.locator("li", { hasText: "验证界面更新" }),
    ).toHaveAttribute("data-status", "in_progress");
    await expect
      .poll(() =>
        provider.bodies.some((body) =>
          body.includes("追加要求：验证时保留当前界面状态"),
        ),
      )
      .toBe(true);

    provider.releasePlanFinal();
    await expect(launched.main.getByText("计划测试完成")).toBeVisible();
    await expect(activePlan).toHaveCount(0);
    const completedRun = launched.main.getByRole("button", { name: /已处理/u });
    await completedRun.click();
    const archivedPlan = launched.main.getByLabel("计划记录");
    await expect(archivedPlan).toContainText("实现与验证均已完成。");
    await expect(
      archivedPlan.locator("li", { hasText: "验证界面更新" }),
    ).toHaveAttribute("data-status", "completed");
    const state = await launched.main.evaluate(async () => {
      const chats = await window.charaMate.chat.list({ status: "active" });
      if (!chats.ok || !chats.value[0]) return null;
      return window.charaMate.chat.getSnapshot({ chatId: chats.value[0].id });
    });
    if (!state?.ok || !state.value) {
      throw new Error("Missing Plan E2E state");
    }
    expect(
      state.value.runItems.filter(({ kind }) => kind === "plan"),
    ).toHaveLength(3);
    expect(
      state.value.runItems.filter(({ kind }) => kind === "user_message"),
    ).toHaveLength(2);
    expect(
      provider.bodies.every((body) => !body.includes("tool_search_output")),
    ).toBe(true);

    await application.close();
    application = undefined;
    expectCleanApplicationShutdown(launched.stderr);
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
