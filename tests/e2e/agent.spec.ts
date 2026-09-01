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
import { RunEventService } from "../../src/main/agent/runEventService";
import { RunEventWriter } from "../../src/main/agent/runEventWriter";
import { RunRepository } from "../../src/main/agent/runRepository";
import { AutomationRepository } from "../../src/main/automations/automationRepository";
import { AutomationService } from "../../src/main/automations/automationService";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { ChatService } from "../../src/main/chat/chatService";
import { openApplicationDatabase } from "../../src/main/db/database";
import { JourneyRepository } from "../../src/main/journey/journeyRepository";
import { JourneyService } from "../../src/main/journey/journeyService";
import { defaultPersonaSnapshot } from "../../src/main/persona/personaPresets";
import { SystemClock } from "../../src/shared/pure/clock";
import { CryptoIdGenerator } from "../../src/shared/pure/id";
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

function objectValue(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function toolModelContent(
  body: string,
  callId: string,
): Readonly<Record<string, unknown>> | undefined {
  const payload: unknown = JSON.parse(body);
  const input = objectValue(payload)?.["input"];
  if (!Array.isArray(input)) return undefined;
  const item = input
    .map((value) => objectValue(value))
    .find(
      (value) =>
        value?.["type"] === "function_call_output" &&
        value["call_id"] === callId,
    );
  const output = item?.["output"];
  if (typeof output !== "string") return undefined;
  const result: unknown = JSON.parse(output);
  return objectValue(objectValue(result)?.["modelContent"]);
}

const evolutionReviewMarker =
  "asynchronous Experience Review candidate generator";

function isEvolutionReviewBody(body: string): boolean {
  return body.includes(evolutionReviewMarker);
}

async function startFakeProvider(browserUrl?: string) {
  const bodies: string[] = [];
  let responseSequence = 0;
  let releasePlanFailure: () => void = () => undefined;
  let releasePlanProgress: () => void = () => undefined;
  let releasePlanFinal: () => void = () => undefined;
  const planFailureGate = new Promise<void>((resolve) => {
    releasePlanFailure = resolve;
  });
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
      const evolutionReviewTask = isEvolutionReviewBody(body);
      const evolutionTeachingTask = body.includes("自进化端到端测试");
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
      const planFailureTask = body.includes("计划失败测试");
      const planTask = body.includes("计划测试");
      const structuredInputTask = body.includes("结构化输入测试");
      const territoryActionTask = body.includes("领地行动端到端验收");
      const territoryTask = body.includes("Agent 端到端验收");
      if (evolutionReviewTask) {
        const requestPayload = JSON.parse(body) as {
          input?: Array<{ content?: string; role?: string }>;
          tools?: unknown[];
        };
        const reviewInput = requestPayload.input?.find(
          ({ role }) => role === "user",
        )?.content;
        const reviewEvidence = reviewInput
          ? (JSON.parse(reviewInput) as {
              messages?: Array<{ content?: string }>;
              runItems?: Array<{ id?: string }>;
            })
          : undefined;
        const teaching = reviewEvidence?.messages?.find(({ content }) =>
          content?.includes("自进化端到端测试"),
        )?.content;
        const sourceItemId = reviewEvidence?.runItems?.find(
          ({ id }) => typeof id === "string",
        )?.id;
        writeSse(
          response,
          finalAnswer(
            responseId,
            JSON.stringify({
              candidates:
                teaching && sourceItemId
                  ? [
                      {
                        evidence: [teaching],
                        proposal: {
                          claimSlot: "preference.response_style",
                          content: "回答时先给结论，再补充必要细节。",
                          kind: "persona_preference",
                          reason: "用户明确教学回答顺序。",
                        },
                        rationale: "这是一条可复用且由用户明确给出的表达偏好。",
                        replayCases: [],
                        sourceItemIds: [sourceItemId],
                      },
                    ]
                  : [],
            }),
          ),
        );
      } else if (titleTask) {
        writeSse(response, finalAnswer(responseId, "E2E 对话标题"));
      } else if (body.includes("气泡第三轮")) {
        writeSse(response, finalAnswer(responseId, "第三轮仍然留在原气泡。"));
      } else if (body.includes("气泡第二轮")) {
        writeSse(response, finalAnswer(responseId, "那就从实验设计接着聊。"));
      } else if (body.includes("气泡连续聊天端到端")) {
        writeSse(response, finalAnswer(responseId, "论文现在写到哪里了？"));
      } else if (evolutionTeachingTask) {
        writeSse(response, finalAnswer(responseId, "明白，以后会先给结论。"));
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
          writeSse(response, [
            functionCall("memory-replace", "record", "memory", {
              basis: "explicit_user_statement",
              claimSlot: "preference.hobbies",
              content: "用户现在的爱好是游泳。",
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
      } else if (territoryActionTask) {
        if (
          body.includes('"call_id":"territory-act"') &&
          body.includes("function_call_output")
        ) {
          writeSse(response, finalAnswer(responseId, "已经在小窝里睡下了"));
        } else if (
          body.includes('"call_id":"territory-observe"') &&
          body.includes("function_call_output")
        ) {
          const observation = toolModelContent(body, "territory-observe");
          const revisionId = observation?.["revisionId"];
          const targets = observation?.["targets"];
          const bed = Array.isArray(targets)
            ? targets
                .map((value) => objectValue(value))
                .find(
                  (value) =>
                    typeof value?.["name"] === "string" &&
                    value["name"].includes("桌宠小窝") &&
                    value["reachable"] === true,
                )
            : undefined;
          const instanceId = bed?.["instanceId"];
          if (
            typeof revisionId !== "string" ||
            typeof instanceId !== "string"
          ) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(
              JSON.stringify({ error: { message: "missing Territory bed" } }),
            );
            return;
          }
          writeSse(response, [
            functionCall("territory-act", "act", "territory", {
              action: "sleep",
              expectedRevisionId: revisionId,
              target: { instanceId, kind: "instance" },
            }),
            completed(responseId),
          ]);
        } else if (body.includes("tool_search_output")) {
          writeSse(response, [
            functionCall("territory-observe", "observe", "territory", {}),
            completed(responseId),
          ]);
        } else {
          writeSse(response, [
            searchCall(
              "territory-action-search",
              "observe the current Territory and let the pet sleep in its bed",
            ),
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
      } else if (planFailureTask) {
        if (
          body.includes('"call_id":"plan-before-failure"') &&
          body.includes("function_call_output")
        ) {
          await planFailureGate;
          response.writeHead(500, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ error: { message: "fixture provider failure" } }),
          );
        } else {
          writeSse(response, [
            functionCall("plan-before-failure", "plan.update", "plan", {
              explanation: "先建立计划，再复现 Provider 失败。",
              plan: [
                { status: "in_progress", step: "建立执行计划" },
                { status: "pending", step: "继续请求 Provider" },
                { status: "pending", step: "汇总结果" },
              ],
            }),
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
      releasePlanFailure();
      releasePlanProgress();
      releasePlanFinal();
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
    releasePlanFinal,
    releasePlanFailure,
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
  await expect(main.getByRole("region", { name: "Chats" })).toBeVisible();
  return { application, character, main, stderr };
}

function expectCleanApplicationShutdown(stderr: readonly string[]): void {
  const output = stderr.join("");
  expect(output).not.toContain("database connection is not open");
  expect(output).not.toContain("UnhandledPromiseRejectionWarning");
  expect(output).not.toContain("Uncaught Exception:");
}

async function saveProvider(page: Page, baseUrl: string): Promise<string> {
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
  if (!saved.ok) throw new Error(saved.error.message);
  await page.reload();
  await expect(page.getByRole("button", { name: "gpt-5.6-sol" })).toBeVisible();
  return saved.value.id;
}

function seedJourneyFollowUp(
  userData: string,
  providerProfileId: string,
): { automationId: string; chatId: string } {
  const database = openApplicationDatabase(
    path.join(userData, "charamate.sqlite"),
  );
  try {
    const ids = new CryptoIdGenerator();
    const clock = new SystemClock();
    const chatRepository = new ChatRepository(database);
    const runRepository = new RunRepository(database);
    const chats = new ChatService(chatRepository, runRepository, ids, clock);
    const automationService = new AutomationService(
      new AutomationRepository(database),
      chats,
      {
        getRun: (runId) => runRepository.getRun(runId),
        listChatRuns: (chatId) => runRepository.getSnapshot(chatId).runs,
        readCompletedAssistantMessage: (runId) =>
          chatRepository
            .listRunMessages(runId)
            .findLast(
              ({ role, status }) =>
                role === "assistant" && status === "completed",
            )?.content,
      },
      {
        startAssistantInitiated: () =>
          Promise.reject(new Error("Seeded automation must run in the app")),
        startAutomation: () =>
          Promise.reject(new Error("Seeded automation must run in the app")),
      },
      ids,
      clock,
      { publish: () => undefined },
      {
        getActiveSnapshot: () => defaultPersonaSnapshot(clock.now()),
        getSnapshot: () => defaultPersonaSnapshot(clock.now()),
      },
    );
    const journeys = new JourneyService(
      new JourneyRepository(database),
      chats,
      { getRun: (runId) => runRepository.getRun(runId) },
      ids,
      clock,
      { publish: () => undefined },
    );
    const homeChat = chats.create({ title: "论文随聊" });
    const journey = journeys.createJourney({
      currentPosition: "正在修改实验设计",
      homeChatId: homeChat.id,
      nextStep: "继续收敛实验变量",
      purpose: "完成未来几个月的毕业论文",
      title: "毕业论文",
    });
    const sourceRunId = ids.generate();
    const now = clock.now();
    const writer = new RunEventWriter(
      runRepository,
      new RunEventService(runRepository, { publish: () => undefined }),
      ids,
      clock,
    );
    writer.startRun({
      chatId: homeChat.id,
      createdAt: now,
      execution: { mode: "chat" },
      id: sourceRunId,
      latestSequence: 1,
      persona: defaultPersonaSnapshot(now),
      provider: {
        apiStyle: "openai-compatible",
        modelId: "gpt-5.6-sol",
        profileId: providerProfileId,
        profileName: "Agent E2E",
      },
      source: "text",
      startedAt: now,
      status: "running",
    });
    writer.transition(sourceRunId, "completed");
    let automationId: string | undefined;
    journeys.setFollowUpScheduler({
      cancel: () => undefined,
      schedule: ({ journey: target, message, run, runAt }) => {
        const automation = automationService.create({
          definition: {
            name: `约好再聊：${target.title}`,
            schedule: { kind: "once", runAt },
            task: {
              delivery: "assistant_message",
              execution: { mode: "chat" },
              goal: `气泡连续聊天端到端：${message}`,
              kind: "agent_task",
              modelId: run.provider.modelId,
              personaId: "00000000-0000-4000-8000-000000000701",
              providerProfileId: run.provider.profileId,
              targetChatId: target.homeChatId,
              toolScope: { mode: "selected", toolNames: [] },
            },
          },
          requestedAt: now,
        });
        automationId = automation.id;
        return automation.id;
      },
    });
    journeys.scheduleFollowUp({
      journeyId: journey.id,
      message: "自然问问论文进展。",
      runAt: new Date(Date.parse(now) + 3_600_000).toISOString(),
      sourceRunId,
    });
    if (!automationId) throw new Error("Failed to seed Journey follow-up");
    return { automationId, chatId: homeChat.id };
  } finally {
    database.close();
  }
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

test("keeps two text replies inside the bound proactive Chat without reopening Main", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-inline-bubble-e2e-"),
  );
  const userData = path.join(root, "user-data");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const provider = await startFakeProvider();
  let application: ElectronApplication | undefined;

  try {
    const setup = await launchApplication(userData, workspace);
    application = setup.application;
    const providerProfileId = await saveProvider(setup.main, provider.baseUrl);
    await application.close();
    application = undefined;
    expectCleanApplicationShutdown(setup.stderr);

    const seeded = seedJourneyFollowUp(userData, providerProfileId);
    const launched = await launchApplication(userData, workspace);
    application = launched.application;
    const queued = await launched.main.evaluate(
      ({ automationId }) =>
        window.charaMate.automations.runNow({
          automationId,
          requestedAt: new Date().toISOString(),
        }),
      { automationId: seeded.automationId },
    );
    expect(queued.ok).toBe(true);

    const conversation = await findWindow(
      launched.application,
      "CharaMate Conversation",
    );
    const bubble = conversation.getByRole("region", {
      name: "角色发起的对话",
    });
    await expect(bubble).toContainText("论文现在写到哪里了？");
    const characterSurfaces = await application.evaluate(
      ({ BrowserWindow, screen }) => {
        const pet = BrowserWindow.getAllWindows().find(
          (candidate) => candidate.getTitle() === "CharaMate Character",
        );
        const bubbleWindow = BrowserWindow.getAllWindows().find(
          (candidate) => candidate.getTitle() === "CharaMate Conversation",
        );
        if (!pet || !bubbleWindow)
          throw new Error("Missing character surfaces");
        const petBounds = pet.getBounds();
        return {
          bubbleBounds: bubbleWindow.getBounds(),
          bubbleFocusable: bubbleWindow.isFocusable(),
          petBounds,
          petFocusable: pet.isFocusable(),
          workArea: screen.getDisplayMatching(petBounds).workArea,
        };
      },
    );
    expect(characterSurfaces.bubbleFocusable).toBe(true);
    expect(characterSurfaces.petFocusable).toBe(process.platform !== "darwin");
    expect(
      characterSurfaces.bubbleBounds.y +
        characterSurfaces.bubbleBounds.height <=
        characterSurfaces.petBounds.y ||
        characterSurfaces.bubbleBounds.y >=
          characterSurfaces.petBounds.y + characterSurfaces.petBounds.height,
    ).toBe(true);
    expect(characterSurfaces.bubbleBounds.x).toBeGreaterThanOrEqual(
      characterSurfaces.workArea.x,
    );
    expect(
      characterSurfaces.bubbleBounds.x + characterSurfaces.bubbleBounds.width,
    ).toBeLessThanOrEqual(
      characterSurfaces.workArea.x + characterSurfaces.workArea.width,
    );

    const petWindow = await findWindow(
      launched.application,
      "CharaMate Character",
    );
    await petWindow.getByRole("button", { name: /桌宠$/ }).hover();
    await expect(
      petWindow.getByRole("button", { name: "开始语音聊天" }),
    ).toBeVisible();
    await expect(bubble).toBeVisible();

    await launched.main.close();
    await expect
      .poll(async () => {
        const titles = await Promise.all(
          (application?.windows() ?? []).map((window) => window.title()),
        );
        return titles.filter((title) => title === "CharaMate").length;
      })
      .toBe(0);

    const input = conversation.getByRole("textbox", {
      name: "在气泡中回复",
    });
    await input.fill("气泡第二轮：从实验设计开始");
    await conversation.getByRole("button", { name: "发送气泡回复" }).click();
    await expect(bubble).toContainText("那就从实验设计接着聊。");
    await expect(input).toHaveValue("");

    await input.fill("气泡第三轮：继续说说变量");
    await conversation.getByRole("button", { name: "发送气泡回复" }).click();
    await expect(bubble).toContainText("第三轮仍然留在原气泡。");
    await expect
      .poll(async () => {
        const titles = await Promise.all(
          (application?.windows() ?? []).map((window) => window.title()),
        );
        return titles.filter((title) => title === "CharaMate").length;
      })
      .toBe(0);

    await conversation.getByRole("button", { name: "打开完整 Chat" }).click();
    const reopenedMain = await findWindow(launched.application, "CharaMate");
    await expect(
      reopenedMain
        .getByRole("region", { name: "会话列表" })
        .getByRole("button", { name: "论文随聊" }),
    ).toBeVisible();
    await expect(
      reopenedMain.getByRole("button", { name: /已处理/u }),
    ).toHaveCount(0);
    const snapshot = await reopenedMain.evaluate(
      (chatId) => window.charaMate.chat.getSnapshot({ chatId }),
      seeded.chatId,
    );
    if (!snapshot.ok || !snapshot.value) {
      throw new Error("Missing proactive Chat snapshot");
    }
    expect(
      snapshot.value.messages.map(({ content, role }) => ({ content, role })),
    ).toEqual([
      { content: "论文现在写到哪里了？", role: "assistant" },
      { content: "气泡第二轮：从实验设计开始", role: "user" },
      { content: "那就从实验设计接着聊。", role: "assistant" },
      { content: "气泡第三轮：继续说说变量", role: "user" },
      { content: "第三轮仍然留在原气泡。", role: "assistant" },
    ]);
    expect(
      snapshot.value.runs.every(({ chatId }) => chatId === seeded.chatId),
    ).toBe(true);
    const journeySnapshot = await reopenedMain.evaluate(() =>
      window.charaMate.journey.getSnapshot(),
    );
    expect(journeySnapshot).toMatchObject({
      ok: true,
      value: { sessions: [] },
    });
    await expect
      .poll(async () =>
        Promise.all(
          launched.application.windows().map((window) => window.title()),
        ),
      )
      .not.toContain("CharaMate Conversation");

    await application.close();
    application = undefined;
    expectCleanApplicationShutdown(launched.stderr);
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
        return { saved };
      },
      { baseUrl: imageBaseUrl },
    );
    expect(prepared.saved).toMatchObject({ ok: true });

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
    expect(snapshot?.candidates[0]).toMatchObject({
      intent: "item",
      status: "ready",
    });
    expect(snapshot?.collection).toHaveLength(1);
    expect(
      snapshot?.candidates[0]?.changeSet?.mutations.some(
        (mutation) =>
          mutation.kind === "definition.put" &&
          mutation.definition.visual.sizePx.width === 72 &&
          mutation.definition.visual.sizePx.height === 72,
      ),
    ).toBe(true);
    expect(imageRequests).toBe(1);
    expect(
      provider.bodies.some((body) => body.includes("awaiting_confirmation")),
    ).toBe(true);

    await launched.main.getByRole("button", { name: "Territory" }).click();
    await expect(
      launched.main.getByTestId("territory-world-canvas"),
    ).toBeVisible();
    await launched.main.getByRole("button", { name: "建造" }).click();
    await launched.main.getByRole("button", { name: /生成/u }).click();
    await expect(
      launched.main.getByText(/Agent 纪念灯/u).first(),
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

test("observes and performs one explicit Territory pet action through the Agent", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-agent-territory-action-e2e-"),
  );
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
    await launched.main
      .getByRole("textbox", { name: "消息" })
      .fill("领地行动端到端验收：请先看看当前领地，再去桌宠小窝睡觉");
    await launched.main.getByRole("button", { name: "发送" }).click();

    await expect(launched.main.getByText("已经在小窝里睡下了")).toBeVisible();
    const snapshot = await launched.main.evaluate(async () => {
      const response = await window.charaMate.territory.getSnapshot();
      return response.ok ? response.value : null;
    });
    expect(snapshot?.pet.behavior).toBe("sleeping");
    expect(
      provider.bodies.some((body) =>
        body.includes('"call_id":"territory-action-search"'),
      ),
    ).toBe(true);
    expect(
      provider.bodies.some((body) =>
        body.includes('"call_id":"territory-observe"'),
      ),
    ).toBe(true);
    const actionOutput = provider.bodies
      .map((body) => toolModelContent(body, "territory-act"))
      .find((value) => value !== undefined);
    expect(actionOutput?.["petBehavior"]).toBe("sleeping");

    await launched.main.getByRole("button", { name: "Territory" }).click();
    await expect(
      launched.main.getByTestId("territory-world-canvas"),
    ).toBeVisible();
    await expect
      .poll(() =>
        launched.main.evaluate(() => {
          const canvas = document.querySelector<HTMLCanvasElement>(
            '[data-testid="territory-world-canvas"] canvas',
          );
          return {
            animation: canvas?.dataset["petAnimation"],
            behavior: canvas?.dataset["petBehavior"],
          };
        }),
      )
      .toEqual({ animation: "idle", behavior: "sleeping" });

    await application.close();
    application = undefined;
    expectCleanApplicationShutdown(launched.stderr);
  } finally {
    await application?.close();
    await provider.close();
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
      (body) =>
        !body.includes("Generate one concise chat title") &&
        !isEvolutionReviewBody(body),
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

test("reviews explicit teaching and applies it only after confirmation", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-evolution-e2e-"),
  );
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
      .fill("自进化端到端测试：以后这样回答，先给结论，再补充细节，请记住。");
    await launched.main.getByRole("button", { name: "发送" }).click();
    await expect(
      launched.main.getByText("明白，以后会先给结论。"),
    ).toBeVisible();

    const candidate = launched.main.getByRole("article", {
      name: "这次学到了什么",
    });
    await expect(candidate).toBeVisible();
    await expect(candidate.getByText("待确认")).toBeVisible();
    await expect(
      candidate.getByText("回答时先给结论，再补充必要细节。"),
    ).toBeVisible();

    const beforeConfirmation = await launched.main.evaluate(() =>
      window.charaMate.memory.list({ query: "先给结论" }),
    );
    if (!beforeConfirmation.ok) {
      throw new Error("Could not inspect Memory before confirmation");
    }
    expect(beforeConfirmation.value.memories).toHaveLength(0);

    await candidate.getByRole("button", { name: "接受" }).click();
    await expect(candidate.getByText("已生效")).toBeVisible();

    const afterConfirmation = await launched.main.evaluate(async () => ({
      evolution: await window.charaMate.evolution.list({ status: "active" }),
      memory: await window.charaMate.memory.list({ query: "先给结论" }),
    }));
    if (!afterConfirmation.evolution.ok || !afterConfirmation.memory.ok) {
      throw new Error("Could not inspect confirmed Evolution state");
    }
    expect(afterConfirmation.evolution.value.candidates).toHaveLength(1);
    expect(afterConfirmation.evolution.value.candidates[0]).toMatchObject({
      kind: "persona_preference",
      status: "active",
    });
    expect(afterConfirmation.memory.value.memories).toHaveLength(1);
    expect(afterConfirmation.memory.value.memories[0]).toMatchObject({
      memory: { claimSlot: "preference.response_style" },
      revision: { content: "回答时先给结论，再补充必要细节。" },
    });

    const reviewBodies = provider.bodies.filter(isEvolutionReviewBody);
    expect(reviewBodies).toHaveLength(1);
    const reviewRequest = JSON.parse(reviewBodies[0]!) as { tools?: unknown[] };
    expect(reviewRequest.tools ?? []).toEqual([]);

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
      (body) =>
        !body.includes("Generate one concise chat title") &&
        !isEvolutionReviewBody(body),
    );
    expect(taskBodies).toHaveLength(5);
    expect(taskBodies[0]).toContain('"name":"charamate_memory"');
    expect(taskBodies[0]).toContain('"name":"record"');
    expect(taskBodies[0]).toContain('"defer_loading":false');
    expect(taskBodies[0]).toContain('"type":"tool_search"');
    expect(taskBodies[0]).toContain('"type":"web_search"');
    expect(taskBodies[2]).toContain("Long-term memory evidence");
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
    const stableMemory = snapshot.value.memories[0]!;
    expect(taskBodies.join("\n")).not.toContain(stableMemory.memory.id);
    expect(taskBodies.join("\n")).not.toContain(
      stableMemory.memory.currentRevisionId,
    );
    expect(taskBodies.join("\n")).not.toContain('"memoryId"');
    expect(taskBodies.join("\n")).not.toContain("[memory:");
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

test("turns a live Plan into non-spinning history when the Provider fails", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-plan-failure-e2e-"),
  );
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
    await launched.main
      .getByRole("textbox", { name: "消息" })
      .fill("计划失败测试：先建立计划，再复现 Provider 失败");
    await launched.main.getByRole("button", { name: "发送" }).click();

    const activePlan = launched.main.getByLabel("活跃计划");
    await expect(activePlan).toBeVisible();
    await activePlan.getByRole("button").hover();
    const currentPlan = launched.main.getByLabel("当前计划");
    await expect(currentPlan).toContainText("建立执行计划");
    await expect(currentPlan.getByText("进行中")).toBeVisible();

    provider.releasePlanFailure();
    await expect(
      launched.main.getByRole("button", { name: /处理失败/u }),
    ).toBeVisible();
    await expect(activePlan).toHaveCount(0);
    const archivedPlan = launched.main.getByLabel("计划记录");
    await expect(archivedPlan).toContainText("执行计划 · 已失败");
    await expect(
      archivedPlan.locator('li[data-status="unfinished"]'),
    ).toHaveCount(3);
    await expect(archivedPlan.getByText("进行中")).toHaveCount(0);

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
