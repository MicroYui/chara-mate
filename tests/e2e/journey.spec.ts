import { companionModelReply } from "../fixtures/companionModel";
import { mkdtemp, rm } from "node:fs/promises";
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
import { _electron as electron } from "playwright";

import { RunRepository } from "../../src/main/agent/runRepository";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { ChatService } from "../../src/main/chat/chatService";
import { openApplicationDatabase } from "../../src/main/db/database";
import { JourneyRepository } from "../../src/main/journey/journeyRepository";
import { JourneyService } from "../../src/main/journey/journeyService";
import { CryptoIdGenerator } from "../../src/shared/pure/id";
import { FakeClock } from "../fixtures/fakeClock";

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

function functionCall(
  callId: string,
  arguments_: Readonly<Record<string, unknown>>,
) {
  return {
    item: {
      arguments: JSON.stringify(arguments_),
      call_id: callId,
      name: "update",
      namespace: "charamate_companionship",
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

function companionshipInput(
  action: "end_session" | "resume_session" | "start_session",
  fields: {
    readonly recap?: string;
    readonly resumeNote?: string;
    readonly sessionId?: string;
    readonly title?: string;
  },
) {
  return {
    action,
    content: null,
    currentPosition: null,
    followUpAt: null,
    followUpMessage: null,
    journeyId: null,
    nextStep: null,
    purpose: null,
    recap: fields.recap ?? null,
    resumeNote: fields.resumeNote ?? null,
    sessionId: fields.sessionId ?? null,
    title: fields.title ?? null,
  };
}

function createJourneyInput() {
  return {
    action: "create_journey",
    content: null,
    currentPosition: "刚开始准备下一份工作",
    followUpAt: null,
    followUpMessage: null,
    journeyId: null,
    nextStep: "先整理简历里的项目经历",
    purpose: "在接下来几个月找到合适的下一份工作",
    recap: null,
    resumeNote: null,
    sessionId: null,
    title: "准备下一份工作",
  };
}

function activeSessionId(instructions: string): string {
  const marker = "concrete activity or matter: ";
  const offset = instructions.lastIndexOf(marker);
  if (offset < 0) throw new Error("Missing companionship context marker");
  const context = JSON.parse(
    instructions.slice(offset + marker.length).split("\n")[0] ?? "",
  ) as {
    activeSession?: { id?: string } | null;
  };
  const id = context.activeSession?.id;
  if (!id) throw new Error("Missing active shared-activity ID");
  return id;
}

async function startFakeProvider(seedSessionId: string) {
  const bodies: string[] = [];
  let mainStep = 0;
  const server = createServer((request, response) => {
    if (request.url?.endsWith("/responses/input_tokens")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "Input token count is not supported by this fixture",
          },
        }),
      );
      return;
    }
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
      const responseId = `journey-response-${String(bodies.length)}`;
      if (body.includes("asynchronous Experience Review candidate generator")) {
        writeSse(response, finalAnswer(responseId, '{"candidates":[]}'));
        return;
      }
      const companionReply = companionModelReply(body);
      if (companionReply !== undefined) {
        writeSse(response, finalAnswer(responseId, companionReply));
        return;
      }
      if (body.includes("Generate one concise chat title")) {
        writeSse(
          response,
          finalAnswer(
            responseId,
            body.includes("找工作") ? "准备找工作" : "毕业论文",
          ),
        );
        return;
      }

      const payload = JSON.parse(body) as { instructions?: string };
      if (mainStep === 0) {
        writeSse(response, [
          functionCall(
            "resume-thesis",
            companionshipInput("resume_session", {
              resumeNote: "从论文研究方法部分继续",
              sessionId: seedSessionId,
            }),
          ),
          completed(responseId),
        ]);
      } else if (mainStep === 1) {
        writeSse(
          response,
          finalAnswer(responseId, "好，我们从上次停下的研究方法部分接着看。"),
        );
      } else if (mainStep === 2) {
        writeSse(response, [
          functionCall(
            "switch-to-movie",
            companionshipInput("start_session", {
              title: "看《海边的曼彻斯特》",
            }),
          ),
          completed(responseId),
        ]);
      } else if (mainStep === 3) {
        writeSse(
          response,
          finalAnswer(responseId, "好，论文先放在这里。我们来看这部电影。"),
        );
      } else if (mainStep === 4) {
        writeSse(response, [
          functionCall(
            "finish-movie",
            companionshipInput("end_session", {
              recap: "一起看完了《海边的曼彻斯特》。",
              sessionId: activeSessionId(payload.instructions ?? ""),
            }),
          ),
          completed(responseId),
        ]);
      } else if (mainStep === 5) {
        writeSse(
          response,
          finalAnswer(responseId, "看完了。刚才那段安静的处理很有余味。"),
        );
      } else if (mainStep === 6) {
        writeSse(
          response,
          finalAnswer(
            responseId,
            "这会持续一阵子。以后你再回来准备求职时，我从这次聊到的地方继续，可以吗？",
          ),
        );
      } else if (mainStep === 7) {
        writeSse(response, [
          functionCall("remember-job-search", createJourneyInput()),
          completed(responseId),
        ]);
      } else {
        writeSse(
          response,
          finalAnswer(
            responseId,
            "好。下次你回来，我们就从简历里的项目经历开始。",
          ),
        );
      }
      mainStep += 1;
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("keeps shared work natural while Agent owns every internal lifecycle change", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-journey-e2e-"),
  );
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let provider: Awaited<ReturnType<typeof startFakeProvider>> | undefined;

  try {
    const database = openApplicationDatabase(
      path.join(userDataDirectory, "charamate.sqlite"),
    );
    const ids = new CryptoIdGenerator();
    const clock = new FakeClock("2026-08-13T09:00:00.000Z");
    const chats = new ChatService(
      new ChatRepository(database),
      new RunRepository(database),
      ids,
      clock,
    );
    const journeys = new JourneyService(
      new JourneyRepository(database),
      chats,
      { getRun: () => undefined },
      ids,
      clock,
      { publish: () => undefined },
    );
    const homeChat = chats.create({ title: "毕业论文" });
    const journey = journeys.createJourney({
      currentPosition: "正在修改研究方法部分",
      homeChatId: homeChat.id,
      nextStep: "核对方法选择与研究问题是否一致",
      purpose: "完成未来几个月的毕业论文",
      title: "毕业论文",
    });
    const thesisSession = journeys.startSession({
      chatId: homeChat.id,
      journeyId: journey.id,
      resumeNote: "从论文研究方法部分继续",
      title: "修改论文研究方法",
    });
    journeys.setSessionStatus({
      resumeNote: "从论文研究方法部分继续",
      sessionId: thesisSession.id,
      status: "paused",
    });
    database.close();

    provider = await startFakeProvider(thesisSession.id);
    application = await electron.launch({
      args: [projectRoot],
      cwd: projectRoot,
      env: {
        ...process.env,
        CHARAMATE_DEV_DASHBOARD: "0",
        CHARAMATE_USER_DATA_DIR: userDataDirectory,
      },
    });
    const page = await application.firstWindow();
    await expect(page.getByRole("button", { name: "Chats" })).toBeVisible();
    const saved = await page.evaluate(
      ({ baseUrl }) =>
        window.charaMate.provider.saveProfile({
          credential: { mode: "replace", value: "sk-journey-e2e-secret" },
          profile: {
            apiStyle: "openai-compatible",
            baseUrl,
            chatModel: "gpt-5.6-sol",
            name: "Journey E2E",
          },
        }),
      { baseUrl: provider.baseUrl },
    );
    expect(saved.ok).toBe(true);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "gpt-5.6-sol" }),
    ).toBeVisible();

    const chatList = page.getByRole("region", { name: "会话列表" });
    await chatList
      .getByRole("button", { exact: true, name: "毕业论文" })
      .click();
    await expect(
      page.getByRole("region", { name: "Mika 正在和你一起" }),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => Object.keys(window.charaMate.journey).sort()),
      )
      .toEqual(["getSnapshot", "subscribeChanged"]);

    const send = async (message: string) => {
      await page.getByRole("textbox", { name: "消息" }).fill(message);
      await page.getByRole("button", { name: "发送" }).click();
    };

    await send("我们继续修改论文吧，从研究方法那里接着来。");
    await expect(
      page.getByText("好，我们从上次停下的研究方法部分接着看。"),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Mika 正在和你一起" }),
    ).toContainText("修改论文研究方法");

    await send("论文先放一下，现在我们换成看《海边的曼彻斯特》。");
    await expect(
      page.getByText("好，论文先放在这里。我们来看这部电影。"),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Mika 正在和你一起" }),
    ).toContainText("看《海边的曼彻斯特》");
    const switched = await page.evaluate(() =>
      window.charaMate.journey.getSnapshot(),
    );
    expect(switched).toMatchObject({
      ok: true,
      value: {
        activeSession: { status: "active", title: "看《海边的曼彻斯特》" },
        sessions: expect.arrayContaining([
          expect.objectContaining({ id: thesisSession.id, status: "paused" }),
        ]),
      },
    });

    await page.getByRole("button", { name: "Memory" }).click();
    await expect(
      page.getByRole("region", { name: "Mika 正在和你一起" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "回到对话" }).click();
    await send("电影看完了，这次就到这里。");
    await expect(
      page.getByText("看完了。刚才那段安静的处理很有余味。"),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Mika 正在和你一起" }),
    ).toHaveCount(0);

    const afterMovie = await page.evaluate(() =>
      window.charaMate.journey.getSnapshot(),
    );
    expect(afterMovie).toMatchObject({
      ok: true,
      value: {
        journeys: [
          expect.objectContaining({ id: journey.id, status: "active" }),
        ],
        sessions: [
          expect.objectContaining({ id: thesisSession.id, status: "paused" }),
        ],
      },
    });

    await page.getByRole("button", { name: "新建对话" }).click();
    await send("接下来几个月我要准备找工作，先从整理简历开始。");
    await expect(
      page.getByText(
        "这会持续一阵子。以后你再回来准备求职时，我从这次聊到的地方继续，可以吗？",
      ),
    ).toBeVisible();
    const beforeConfirmation = await page.evaluate(() =>
      window.charaMate.journey.getSnapshot(),
    );
    expect(beforeConfirmation).toMatchObject({
      ok: true,
      value: { journeys: [expect.objectContaining({ id: journey.id })] },
    });

    await send("可以，以后就从上次停下的地方继续。");
    await expect(
      page.getByText("好。下次你回来，我们就从简历里的项目经历开始。"),
    ).toBeVisible();
    const afterConfirmation = await page.evaluate(() =>
      window.charaMate.journey.getSnapshot(),
    );
    expect(afterConfirmation).toMatchObject({
      ok: true,
      value: {
        journeys: expect.arrayContaining([
          expect.objectContaining({ id: journey.id, title: "毕业论文" }),
          expect.objectContaining({
            purpose: "在接下来几个月找到合适的下一份工作",
            status: "active",
            title: "准备下一份工作",
          }),
        ]),
      },
    });
    await expect(
      chatList.getByRole("button", { exact: true, name: "准备找工作" }),
    ).toBeVisible();
    const visibleText = await page.locator("body").innerText();
    expect(visibleText).not.toMatch(
      /同行中|待续共处|同行回望|Journey|Together Session|Home Chat/u,
    );
    await expect(
      page.getByRole("button", { name: /暂停当前共处|结束当前共处|告一段落/u }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: /已处理/u })).toHaveCount(0);
  } finally {
    try {
      await application?.close();
      await provider?.close();
    } finally {
      await rm(userDataDirectory, { force: true, recursive: true });
    }
  }
});
