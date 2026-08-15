import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ActivityAssetStore } from "./activityAssetStore";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("ActivityAssetStore", () => {
  it("persists the captured PNG bytes once and hashes them asynchronously", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "activity-assets-"));
    roots.push(root);
    const bytes = Buffer.from("single-encoded-png");
    const store = new ActivityAssetStore(root);

    const record = await store.save(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      {
        bytes,
        height: 720,
        mediaType: "image/png",
        width: 1280,
      },
      "2026-08-15T00:00:00.000Z",
    );

    expect(await readFile(store.resolve(record))).toEqual(bytes);
    expect(record).toMatchObject({
      byteLength: bytes.byteLength,
      height: 720,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      width: 1280,
    });
  });
});
