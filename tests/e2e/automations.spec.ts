import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("runs and restores Automations through the typed desktop boundary", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-automations-e2e-"),
  );
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;

  const launch = async () => {
    const launched = await electron.launch({
      args: [projectRoot],
      cwd: projectRoot,
      env: {
        ...process.env,
        CHARAMATE_USER_DATA_DIR: userDataDirectory,
      },
    });
    const page = await launched.firstWindow();
    await expect(page.getByRole("heading", { name: "新对话" })).toBeVisible();
    return { launched, page };
  };

  try {
    const first = await launch();
    application = first.launched;
    const firstResult = await first.page.evaluate(async () => {
      const requestedAt = new Date().toISOString();
      const definition = {
        name: "桌面边界提醒",
        schedule: {
          kind: "once" as const,
          runAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
        task: {
          delivery: "bubble" as const,
          kind: "reminder" as const,
          message: "检查 Automations Core。",
        },
      };
      const created = await window.charaMate.automations.create({
        definition,
        requestedAt,
      });
      if (!created.ok) throw new Error(created.error.message);
      const paused = await window.charaMate.automations.setPaused({
        automationId: created.value.id,
        expectedRevision: created.value.revision,
        paused: true,
        requestedAt,
      });
      if (!paused.ok) throw new Error(paused.error.message);

      const finished = new Promise<
        Parameters<
          Parameters<typeof window.charaMate.automations.subscribe>[0]
        >[0]
      >((resolve) => {
        const unsubscribe = window.charaMate.automations.subscribe((event) => {
          if (event.event.type !== "automation.run.finished") return;
          unsubscribe();
          resolve(event);
        });
      });
      const queued = await window.charaMate.automations.runNow({
        automationId: created.value.id,
        requestedAt,
      });
      if (!queued.ok) throw new Error(queued.error.message);
      const finishedEvent = await finished;

      const updated = await window.charaMate.automations.update({
        automationId: created.value.id,
        definition: { ...definition, name: "已更新桌面边界提醒" },
        expectedRevision: paused.value.revision,
        requestedAt,
      });
      if (!updated.ok) throw new Error(updated.error.message);
      const resumed = await window.charaMate.automations.setPaused({
        automationId: created.value.id,
        expectedRevision: updated.value.revision,
        paused: false,
        requestedAt,
      });
      if (!resumed.ok) throw new Error(resumed.error.message);
      const detail = await window.charaMate.automations.get({
        automationId: created.value.id,
      });
      if (!detail.ok) throw new Error(detail.error.message);
      return {
        automationId: created.value.id,
        detail: detail.value,
        finishedEvent,
        queued: queued.value,
      };
    });

    expect(firstResult.detail.automation).toMatchObject({
      definition: { name: "已更新桌面边界提醒" },
      revision: 2,
      state: "active",
    });
    expect(firstResult.detail.runs).toHaveLength(1);
    expect(firstResult.detail.runs[0]).toMatchObject({
      automationRevision: 1,
      definition: { name: "桌面边界提醒" },
      status: "completed",
      summary: "检查 Automations Core。",
      trigger: { kind: "manual" },
    });
    expect(firstResult.finishedEvent).toMatchObject({
      event: {
        automationRunId: firstResult.queued.id,
        status: "completed",
        type: "automation.run.finished",
      },
      eventId: firstResult.queued.id,
    });

    await application.close();
    application = undefined;
    const second = await launch();
    application = second.launched;
    const restored = await second.page.evaluate(async (automationId) => {
      const listed = await window.charaMate.automations.list();
      const detail = await window.charaMate.automations.get({ automationId });
      return { detail, listed };
    }, firstResult.automationId);
    expect(restored.detail).toMatchObject({
      ok: true,
      value: {
        automation: { revision: 2, state: "active" },
        runs: [{ status: "completed" }],
      },
    });
    expect(restored.listed).toMatchObject({
      ok: true,
      value: {
        items: [
          {
            automation: { id: firstResult.automationId },
            recentRun: { status: "completed" },
          },
        ],
      },
    });
  } finally {
    try {
      await application?.close();
    } finally {
      await rm(userDataDirectory, { force: true, recursive: true });
    }
  }
});
