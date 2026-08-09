import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSolidPng } from "../../../tests/fixtures/png";
import { TerritoryCandidateStore } from "./territoryCandidateStore";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Territory candidate cache", () => {
  it("atomically stores and replaces the processed PNG for one candidate", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "territory-candidate-"));
    temporaryDirectories.push(root);
    const first = createSolidPng(2, 2, [250, 0, 250, 0]);
    const second = createSolidPng(2, 2, [30, 80, 150, 255]);
    const removeBackground = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const store = new TerritoryCandidateStore(root, { removeBackground });
    const candidateId = "cf5908f4-f44f-4d98-abd7-c6ceded20b49";

    await store.save(candidateId, Buffer.from("provider-one"));
    expect(await store.read(candidateId)).toEqual(first);
    await store.save(candidateId, Buffer.from("provider-two"));

    expect(await store.read(candidateId)).toEqual(second);
    expect(await store.resolve(candidateId)).toBe(
      path.join(root, candidateId, "preview.png"),
    );
    expect(removeBackground).toHaveBeenCalledTimes(2);
  });

  it("rejects processor output that is not PNG", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "territory-candidate-"));
    temporaryDirectories.push(root);
    const store = new TerritoryCandidateStore(root, {
      removeBackground: () => Buffer.from("not-a-png"),
    });

    await expect(
      store.save(
        "633e0546-a9e4-4d54-8e6f-80903fdc08f9",
        Buffer.from("provider"),
      ),
    ).rejects.toMatchObject({ code: "TERRITORY.IMAGE_PROCESSING_FAILED" });
  });
});
