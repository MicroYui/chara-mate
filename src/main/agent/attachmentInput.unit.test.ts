import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ArtifactReference } from "../../shared/contracts/run";
import {
  AttachmentInputError,
  LocalAttachmentInputProvider,
} from "./attachmentInput";

const temporaryDirectories: string[] = [];

async function temporaryFile(name: string, bytes: Buffer): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "charamate-input-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, name);
  await writeFile(file, bytes);
  return file;
}

function attachment(
  storageKey: string,
  overrides: Partial<ArtifactReference> = {},
): ArtifactReference {
  return {
    artifactId: "11111111-1111-4111-8111-111111111111",
    displayName: "notes.md",
    kind: "file",
    mediaType: "text/markdown",
    storageKey,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("local attachment input", () => {
  it("reads real UTF-8 text and records its digest", async () => {
    const bytes = Buffer.from("# 分享结束了\n\n今天的夕阳很好看", "utf8");
    const file = await temporaryFile("notes.md", bytes);
    const provider = new LocalAttachmentInputProvider((source) =>
      Promise.resolve(source),
    );

    await expect(provider.prepare(attachment(file))).resolves.toEqual({
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      text: bytes.toString("utf8"),
    });
  });

  it("hashes PDF bytes without claiming parsed text", async () => {
    const bytes = Buffer.from("%PDF-1.7\nopaque", "utf8");
    const file = await temporaryFile("brief.pdf", bytes);
    const provider = new LocalAttachmentInputProvider((source) =>
      Promise.resolve(source),
    );

    const prepared = await provider.prepare(
      attachment(file, {
        displayName: "brief.pdf",
        mediaType: "application/pdf",
      }),
    );

    expect(prepared).toEqual({
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(prepared).not.toHaveProperty("text");
  });

  it("rejects invalid UTF-8 for a declared text attachment", async () => {
    const file = await temporaryFile("notes.txt", Buffer.from([0xc3, 0x28]));
    const provider = new LocalAttachmentInputProvider((source) =>
      Promise.resolve(source),
    );

    await expect(
      provider.prepare(
        attachment(file, { displayName: "notes.txt", mediaType: "text/plain" }),
      ),
    ).rejects.toBeInstanceOf(AttachmentInputError);
  });
});
