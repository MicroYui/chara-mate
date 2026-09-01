import { createHash } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";

import type { ArtifactReference } from "../../shared/contracts/run";

export interface PreparedAttachmentInput {
  readonly byteLength: number;
  readonly sha256: string;
  readonly text?: string;
}

export interface AttachmentInputProvider {
  prepare(attachment: ArtifactReference): Promise<PreparedAttachmentInput>;
}

export class AttachmentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentInputError";
  }
}

function isUtf8TextAttachment(attachment: ArtifactReference): boolean {
  const mediaType = attachment.mediaType
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    mediaType === "text/plain" ||
    mediaType === "text/markdown" ||
    mediaType === "text/x-markdown"
  ) {
    return true;
  }
  return [".md", ".markdown", ".txt"].includes(
    path.extname(attachment.displayName).toLowerCase(),
  );
}

export class LocalAttachmentInputProvider implements AttachmentInputProvider {
  constructor(
    private readonly resolveSource: (source: string) => Promise<string>,
  ) {}

  async prepare(
    attachment: ArtifactReference,
  ): Promise<PreparedAttachmentInput> {
    const resolved = await this.resolveSource(attachment.storageKey);
    const bytes = await readFile(resolved);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (!isUtf8TextAttachment(attachment)) {
      return { byteLength: bytes.byteLength, sha256 };
    }
    try {
      return {
        byteLength: bytes.byteLength,
        sha256,
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      };
    } catch {
      throw new AttachmentInputError(
        `无法按 UTF-8 读取“${attachment.displayName}”，请转换编码后重试。`,
      );
    }
  }
}
