import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { _electron as electron } from "playwright";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("persists Provider metadata while keeping the API Key encrypted and write-only", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-provider-e2e-"),
  );
  const secret = "sk-e2e-provider-secret-never-persist-plain";
  let observedAuthorization = "";
  const server = createServer((request, response) => {
    observedAuthorization = request.headers.authorization ?? "";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: [
          {
            created: 1,
            id: "e2e-model",
            object: "model",
            owned_by: "e2e",
          },
        ],
        object: "list",
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${String(address.port)}/v1`;

  async function launchApplication() {
    const application = await electron.launch({
      args: [projectRoot],
      cwd: projectRoot,
      env: {
        ...process.env,
        CHARAMATE_USER_DATA_DIR: userDataDirectory,
      },
    });
    const page = await application.firstWindow();
    await expect(
      page.getByRole("heading", { name: "工程基线已就绪" }),
    ).toBeVisible();
    return { application, page };
  }

  try {
    const first = await launchApplication();
    const saved = await first.page.evaluate(
      async ({ apiKey, url }) =>
        window.charaMate.provider.saveProfile({
          credential: { mode: "replace", value: apiKey },
          profile: {
            apiStyle: "openai-compatible",
            baseUrl: url,
            chatModel: "e2e-model",
            name: "E2E Provider",
          },
        }),
      { apiKey: secret, url: baseUrl },
    );
    expect(saved).toMatchObject({
      ok: true,
      value: {
        chatModel: "e2e-model",
        hasApiKey: true,
        name: "E2E Provider",
      },
    });
    expect(JSON.stringify(saved)).not.toContain(secret);
    const profileId = saved.ok ? saved.value.id : "";

    const discovery = await first.page.evaluate(
      (id) =>
        window.charaMate.provider.discoverModels({
          connection: { profileId: id, source: "saved_profile" },
        }),
      profileId,
    );
    expect(discovery).toEqual({
      ok: true,
      value: {
        models: [{ createdAtUnixSeconds: 1, id: "e2e-model", ownedBy: "e2e" }],
        status: "available",
      },
    });
    expect(observedAuthorization).toBe(`Bearer ${secret}`);
    await first.application.close();

    const databasePath = path.join(userDataDirectory, "charamate.sqlite");
    const secretPath = path.join(userDataDirectory, "secrets.bin");
    expect((await readFile(databasePath)).includes(Buffer.from(secret))).toBe(
      false,
    );
    expect((await readFile(secretPath)).includes(Buffer.from(secret))).toBe(
      false,
    );
    const database = new Database(databasePath, { readonly: true });
    const row = database
      .prepare(
        "SELECT api_key_ref AS apiKeyRef, base_url AS baseUrl FROM provider_profiles WHERE id = ?",
      )
      .get(profileId) as { apiKeyRef: string; baseUrl: string };
    database.close();
    expect(row.baseUrl).toBe(baseUrl);
    expect(row.apiKeyRef).not.toBe(secret);

    const second = await launchApplication();
    const profiles = await second.page.evaluate(() =>
      window.charaMate.provider.listProfiles(),
    );
    expect(profiles).toMatchObject({
      ok: true,
      value: [{ hasApiKey: true, id: profileId, name: "E2E Provider" }],
    });
    expect(JSON.stringify(profiles)).not.toContain(secret);
    await expect(
      second.page.evaluate(
        (id) =>
          window.charaMate.provider.testConnection({
            connection: { profileId: id, source: "saved_profile" },
          }),
        profileId,
      ),
    ).resolves.toEqual({
      ok: true,
      value: { modelCount: 1, status: "connected" },
    });
    await second.application.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(userDataDirectory, { force: true, recursive: true });
  }
});
