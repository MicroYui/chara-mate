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
import { _electron as electron, type Page } from "playwright";

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

function writeAnswer(response: ServerResponse, id: string, text: string): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(
    `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: text, type: "response.output_text.delta" })}\n\n`,
  );
  response.write(
    `event: response.completed\ndata: ${JSON.stringify({
      response: {
        id,
        usage: {
          input_tokens: 40,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 8,
        },
      },
      type: "response.completed",
    })}\n\n`,
  );
  response.write("data: [DONE]\n\n");
  response.end();
}

async function startFakeProvider() {
  let responseSequence = 0;
  let releaseFirstTitle: () => void = () => undefined;
  const firstTitleGate = new Promise<void>((resolve) => {
    releaseFirstTitle = resolve;
  });
  let firstTitleReleased = false;
  const server = createServer((request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          context_window: 32_000,
          id: "chat-e2e-model",
          max_input_tokens: 30_000,
          max_output_tokens: 2_000,
          object: "model",
        }),
      );
      return;
    }
    void requestText(request).then(async (body) => {
      responseSequence += 1;
      const id = `chat-response-${String(responseSequence)}`;
      if (body.includes("Generate one concise chat title")) {
        if (!firstTitleReleased) await firstTitleGate;
        writeAnswer(
          response,
          id,
          body.includes("临时会话测试") ? "临时会话" : "北京周末行程规划",
        );
        return;
      }
      writeAnswer(
        response,
        id,
        body.includes("临时会话测试") ? "临时会话已记录" : "行程规划已记录",
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        releaseFirstTitle();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    releaseFirstTitle: () => {
      firstTitleReleased = true;
      releaseFirstTitle();
    },
  };
}

async function saveProvider(page: Page, baseUrl: string): Promise<void> {
  const saved = await page.evaluate(
    ({ url }) =>
      window.charaMate.provider.saveProfile({
        credential: { mode: "replace", value: "sk-chats-e2e" },
        profile: {
          apiStyle: "openai-compatible",
          baseUrl: url,
          chatModel: "chat-e2e-model",
          name: "Chats E2E",
        },
      }),
    { url: baseUrl },
  );
  expect(saved.ok).toBe(true);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "chat-e2e-model" }),
  ).toBeVisible();
}

test("manages real Chats and restores product state after an Electron restart", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-chats-e2e-"),
  );
  const provider = await startFakeProvider();
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;

  const launchApplication = async (expectedHeading = "新对话") => {
    const launched = await electron.launch({
      args: [projectRoot],
      cwd: projectRoot,
      env: {
        ...process.env,
        CHARAMATE_USER_DATA_DIR: userDataDirectory,
      },
    });
    const page = await launched.firstWindow();
    await expect(
      page.getByRole("heading", { name: expectedHeading }),
    ).toBeVisible();
    return { launched, page };
  };

  try {
    const first = await launchApplication();
    application = first.launched;
    const page = first.page;
    await expect(page.getByRole("button", { name: "Territory" })).toBeVisible();
    const petImage = page.getByRole("img", {
      name: "Columbinya 桌宠缩略图",
    });
    await expect(petImage).toHaveAttribute("style", /columbinya/u);

    const settingsBox = await page
      .getByRole("button", { name: "Settings" })
      .boundingBox();
    const collapseBox = await page
      .getByRole("button", { name: "折叠侧栏" })
      .boundingBox();
    expect(settingsBox).not.toBeNull();
    expect(collapseBox).not.toBeNull();
    expect(
      Math.abs(
        settingsBox!.y +
          settingsBox!.height / 2 -
          (collapseBox!.y + collapseBox!.height / 2),
      ),
    ).toBeLessThan(1);

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { exact: true, name: "Agent" }).click();
    await page.getByLabel("默认模式").selectOption("agent");
    await page.getByLabel("Agent 默认权限").selectOption("full_access");
    await expect(
      page.getByRole("heading", { name: "默认执行方式" }),
    ).toBeVisible();
    await expect(page.getByLabel("默认模式")).toHaveValue("agent");
    await expect(page.getByLabel("Agent 默认权限")).toHaveValue("full_access");
    await page
      .getByRole("button", { exact: true, name: "Browser & Computer" })
      .click();
    await expect(
      page.getByRole("heading", { name: "受管浏览器与系统能力" }),
    ).toBeVisible();
    await expect(page.getByText("辅助功能")).toBeVisible();
    await expect(page.getByText("屏幕录制")).toBeVisible();
    await page.getByRole("button", { name: "Chats" }).click();
    await saveProvider(page, provider.baseUrl);

    await page.getByRole("button", { name: "新建对话" }).click();
    await expect(
      page.getByRole("button", { exact: true, name: "新对话" }),
    ).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "新对话" })).toBeVisible();
    const composer = page.getByRole("textbox", { name: "消息" });
    await composer.fill("帮我规划北京周末行程");
    await page.getByRole("button", { name: "发送" }).click();
    await expect(
      page.getByRole("button", {
        exact: true,
        name: "帮我规划北京周末行程",
      }),
    ).toBeVisible();
    await expect(page.getByText("行程规划已记录")).toBeVisible();
    provider.releaseFirstTitle();
    await expect(
      page.getByRole("heading", { name: "北京周末行程规划" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "更多会话操作" }).click();
    await page.getByRole("menuitem", { name: "重命名" }).click();
    const titleInput = page.getByRole("textbox", { name: "会话标题" });
    await titleInput.fill("Phase 1 真实会话");
    await titleInput.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Phase 1 真实会话" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "更多会话操作" }).click();
    await page.getByRole("menuitem", { name: "置顶" }).click();
    await expect(page.getByLabel("已置顶")).toBeVisible();

    await page.getByRole("button", { name: "新建对话" }).click();
    await expect(
      page.getByRole("button", { exact: true, name: "新对话" }),
    ).toHaveCount(0);
    await composer.fill("临时会话测试");
    await page.getByRole("button", { name: "发送" }).click();
    await expect(page.getByRole("heading", { name: "临时会话" })).toBeVisible();

    const search = page.getByRole("searchbox", { name: "搜索会话" });
    await search.focus();
    const searchFocusLayout = await search.evaluate((input) => {
      const field = input.closest("label");
      const navigation = input.closest("section");
      if (!field || !navigation) throw new Error("Missing search layout");
      const fieldBounds = field.getBoundingClientRect();
      const navigationBounds = navigation.getBoundingClientRect();
      return {
        boxShadow: window.getComputedStyle(field).boxShadow,
        topClearance: fieldBounds.top - navigationBounds.top,
      };
    });
    expect(searchFocusLayout.boxShadow).not.toBe("none");
    expect(searchFocusLayout.topClearance).toBeGreaterThanOrEqual(2);
    await search.fill("真实");
    await expect(
      page.getByRole("button", { exact: true, name: /Phase 1 真实会话/u }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { exact: true, name: "临时会话" }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { exact: true, name: /Phase 1 真实会话/u })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "归档" }).click();
    await expect(page.getByText("没有匹配的会话")).toBeVisible();
    await page.getByRole("button", { name: "已归档" }).click();
    await expect(
      page.getByRole("heading", { name: "Phase 1 真实会话" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "恢复会话" }).click();
    await expect(page.getByRole("button", { name: "最近" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await search.fill("");
    await page
      .getByRole("button", { exact: true, name: "临时会话" })
      .click({ button: "right" });
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("menuitem", { name: "删除" }).click();
    await expect(
      page.getByRole("button", { exact: true, name: "临时会话" }),
    ).toHaveCount(0);

    const savedBounds = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.getTitle() === "CharaMate",
      );
      if (!window) throw new Error("Missing main window");
      const current = window.getBounds();
      window.setBounds({
        height: 700,
        width: 1020,
        x: current.x + 20,
        y: current.y + 20,
      });
      return window.getBounds();
    });
    await page.getByRole("button", { name: "折叠侧栏" }).click();
    await expect(page.getByRole("button", { name: "展开侧栏" })).toBeVisible();

    await application.close();
    application = undefined;
    const second = await launchApplication("Phase 1 真实会话");
    application = second.launched;
    await expect(
      second.page.getByRole("heading", { name: "Phase 1 真实会话" }),
    ).toBeVisible();
    await expect(
      second.page.getByRole("button", { name: "展开侧栏" }),
    ).toBeVisible();
    const restoredBounds = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.getTitle() === "CharaMate",
      );
      if (!window) throw new Error("Missing main window");
      return window.getBounds();
    });
    expect(
      Math.abs(restoredBounds.width - savedBounds.width),
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs(restoredBounds.height - savedBounds.height),
    ).toBeLessThanOrEqual(2);
    expect(Math.abs(restoredBounds.x - savedBounds.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(restoredBounds.y - savedBounds.y)).toBeLessThanOrEqual(2);

    await second.page.getByRole("button", { name: "展开侧栏" }).click();
    await expect(
      second.page.getByRole("button", {
        exact: true,
        name: /Phase 1 真实会话/u,
      }),
    ).toBeVisible();
    await expect(
      second.page.getByRole("button", { exact: true, name: "临时会话" }),
    ).toHaveCount(0);
  } finally {
    try {
      await application?.close();
    } finally {
      await provider.close();
      await rm(userDataDirectory, { force: true, recursive: true });
    }
  }
});
