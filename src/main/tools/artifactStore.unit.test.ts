import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { IdGenerator } from "../../shared/pure/id";
import { ArtifactStore } from "./artifactStore";

const roots: string[] = [];
const scopeId = "10000000-0000-4000-8000-000000000001";
const artifactId = "20000000-0000-4000-8000-000000000001";
const unusedIdGenerator: IdGenerator = {
  generate() {
    throw new Error("Stable artifact storage must not generate another ID");
  },
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function createStore(): Promise<{
  readonly root: string;
  readonly store: ArtifactStore;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "artifact-store-"));
  roots.push(root);
  return { root, store: new ArtifactStore(root, unusedIdGenerator) };
}

describe("ArtifactStore.storeBufferWithStableId", () => {
  it("creates a stable managed path with byte length and hash metadata", async () => {
    const { root, store } = await createStore();
    const content = Buffer.from("companion image bytes");

    const artifact = await store.storeBufferWithStableId(
      scopeId,
      artifactId,
      "sunset.png",
      content,
      "image/png",
      "image",
    );

    expect(artifact).toEqual({
      artifactId,
      byteLength: content.byteLength,
      displayName: "sunset.png",
      kind: "image",
      mediaType: "image/png",
      sha256: createHash("sha256").update(content).digest("hex"),
      storageKey: path.join(scopeId, `${artifactId}.bin`),
    });
    expect(store.resolvePath(artifact.storageKey)).toBe(
      path.join(root, scopeId, `${artifactId}.bin`),
    );
    expect(await readFile(store.resolvePath(artifact.storageKey))).toEqual(
      content,
    );
  });

  it("returns the same reference when the same bytes are retried", async () => {
    const { root, store } = await createStore();
    const content = Buffer.from("retry-safe document bytes");
    const input = [
      scopeId,
      artifactId,
      "notes.pdf",
      content,
      "application/pdf",
      "file",
    ] as const;

    const first = await store.storeBufferWithStableId(...input);
    const retried = await store.storeBufferWithStableId(...input);

    expect(retried).toEqual(first);
    expect(await readdir(path.join(root, scopeId))).toEqual([
      `${artifactId}.bin`,
    ]);
    expect(await readFile(store.resolvePath(first.storageKey))).toEqual(
      content,
    );
  });

  it("publishes one complete file when matching retries race", async () => {
    const { root, store } = await createStore();
    const firstBuffer = Buffer.alloc(256 * 1024, 0x61);
    const secondBuffer = Buffer.from(firstBuffer);

    const [first, second] = await Promise.all([
      store.storeBufferWithStableId(
        scopeId,
        artifactId,
        "photo.jpg",
        firstBuffer,
        "image/jpeg",
        "image",
      ),
      store.storeBufferWithStableId(
        scopeId,
        artifactId,
        "photo.jpg",
        secondBuffer,
        "image/jpeg",
        "image",
      ),
    ]);

    expect(second).toEqual(first);
    expect(await readFile(store.resolvePath(first.storageKey))).toEqual(
      firstBuffer,
    );
    expect(await readdir(path.join(root, scopeId))).toEqual([
      `${artifactId}.bin`,
    ]);
  });

  it("rejects different bytes for the same IDs without overwriting", async () => {
    const { store } = await createStore();
    const original = Buffer.from("original");
    const conflicting = Buffer.from("changed!");
    const artifact = await store.storeBufferWithStableId(
      scopeId,
      artifactId,
      "shared.md",
      original,
      "text/markdown",
      "file",
    );

    await expect(
      store.storeBufferWithStableId(
        scopeId,
        artifactId,
        "shared.md",
        conflicting,
        "text/markdown",
        "file",
      ),
    ).rejects.toThrow(
      `Artifact ${artifactId} already exists with different bytes`,
    );
    expect(await readFile(store.resolvePath(artifact.storageKey))).toEqual(
      original,
    );
  });

  it("publishes exactly one complete file when conflicting writes race", async () => {
    const { root, store } = await createStore();
    const firstBuffer = Buffer.alloc(256 * 1024, 0x61);
    const secondBuffer = Buffer.alloc(256 * 1024, 0x62);
    const results = await Promise.allSettled([
      store.storeBufferWithStableId(
        scopeId,
        artifactId,
        "photo.jpg",
        firstBuffer,
        "image/jpeg",
        "image",
      ),
      store.storeBufferWithStableId(
        scopeId,
        artifactId,
        "photo.jpg",
        secondBuffer,
        "image/jpeg",
        "image",
      ),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejectionReason: unknown = rejected[0]?.reason;
    expect(rejectionReason).toBeInstanceOf(Error);
    expect((rejectionReason as Error).message).toBe(
      `Artifact ${artifactId} already exists with different bytes`,
    );
    const stored = await readFile(
      store.resolvePath(path.join(scopeId, `${artifactId}.bin`)),
    );
    expect(stored.equals(firstBuffer) || stored.equals(secondBuffer)).toBe(
      true,
    );
    expect(await readdir(path.join(root, scopeId))).toEqual([
      `${artifactId}.bin`,
    ]);
  });

  it("keeps generated-ID storeBuffer paths unchanged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "artifact-store-"));
    roots.push(root);
    const generatedId = "30000000-0000-4000-8000-000000000001";
    const store = new ArtifactStore(root, { generate: () => generatedId });
    const content = Buffer.from("existing storeBuffer behavior");

    const artifact = await store.storeBuffer(
      scopeId,
      "existing.pdf",
      content,
      "application/pdf",
      "file",
    );

    expect(artifact.artifactId).toBe(generatedId);
    expect(artifact.storageKey).toBe(path.join(scopeId, `${generatedId}.pdf`));
    expect(await readFile(store.resolvePath(artifact.storageKey))).toEqual(
      content,
    );
  });
});
