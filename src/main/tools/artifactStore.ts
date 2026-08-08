import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ArtifactReference } from "../../shared/contracts/run";
import type { IdGenerator } from "../../shared/pure/id";

const MAX_DISPLAY_OUTPUT_BYTES = 32_768;

export interface StoredToolOutput {
  readonly artifacts: readonly ArtifactReference[];
  readonly displayOutput: string;
}

export class ArtifactStore {
  constructor(
    private readonly rootDirectory: string,
    private readonly idGenerator: IdGenerator,
  ) {}

  async storeText(
    runId: string,
    displayName: string,
    content: string,
    mediaType = "text/plain",
  ): Promise<ArtifactReference> {
    const artifactId = this.idGenerator.generate();
    const directory = path.join(this.rootDirectory, runId);
    const storageKey = path.join(runId, `${artifactId}.txt`);
    const destination = path.join(this.rootDirectory, storageKey);
    await mkdir(directory, { recursive: true });
    await writeFile(destination, content, "utf8");
    return {
      artifactId,
      byteLength: Buffer.byteLength(content, "utf8"),
      displayName,
      kind: "log",
      mediaType,
      sha256: createHash("sha256").update(content).digest("hex"),
      storageKey,
    };
  }

  async storeBuffer(
    runId: string,
    displayName: string,
    content: Buffer,
    mediaType: string,
    kind: ArtifactReference["kind"],
  ): Promise<ArtifactReference> {
    const artifactId = this.idGenerator.generate();
    const extension = path.extname(displayName) || ".bin";
    const directory = path.join(this.rootDirectory, runId);
    const storageKey = path.join(runId, `${artifactId}${extension}`);
    const destination = path.join(this.rootDirectory, storageKey);
    await mkdir(directory, { recursive: true });
    await writeFile(destination, content);
    return {
      artifactId,
      byteLength: content.byteLength,
      displayName,
      kind,
      mediaType,
      sha256: createHash("sha256").update(content).digest("hex"),
      storageKey,
    };
  }

  async storeFile(
    runId: string,
    displayName: string,
    sourcePath: string,
    mediaType = "application/octet-stream",
  ): Promise<ArtifactReference> {
    const artifactId = this.idGenerator.generate();
    const extension = path.extname(displayName) || path.extname(sourcePath);
    const directory = path.join(this.rootDirectory, runId);
    const storageKey = path.join(runId, `${artifactId}${extension}`);
    const destination = path.join(this.rootDirectory, storageKey);
    await mkdir(directory, { recursive: true });
    await copyFile(sourcePath, destination);
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(
      destination,
    ) as AsyncIterable<unknown>) {
      if (Buffer.isBuffer(chunk)) digest.update(chunk);
      else if (typeof chunk === "string") digest.update(chunk);
    }
    const metadata = await stat(destination);
    return {
      artifactId,
      byteLength: metadata.size,
      displayName,
      kind: "file",
      mediaType,
      sha256: digest.digest("hex"),
      storageKey,
    };
  }

  async presentText(
    runId: string,
    displayName: string,
    content: string,
  ): Promise<StoredToolOutput> {
    if (Buffer.byteLength(content, "utf8") <= MAX_DISPLAY_OUTPUT_BYTES) {
      return { artifacts: [], displayOutput: content };
    }
    const artifact = await this.storeText(runId, displayName, content);
    const prefix = Buffer.from(content, "utf8")
      .subarray(0, MAX_DISPLAY_OUTPUT_BYTES)
      .toString("utf8");
    return {
      artifacts: [artifact],
      displayOutput: `${prefix}\n\n[完整输出已保存为 ${displayName}]`,
    };
  }
}
