import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { parseSchema } from "../../shared/schemas/validation";

const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const fileName = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" });
/** The build supplies one encoder. This manifest is not a user model catalogue. */
export const LocalEmbeddingManifestSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    platform: Type.Literal("darwin"),
    architecture: Type.Literal("arm64"),
    engine: Type.Object(
      {
        version: Type.String({ minLength: 1 }),
        commit: Type.String({ pattern: "^[a-f0-9]{40}$" }),
        archiveSha256: sha256,
      },
      { additionalProperties: false },
    ),
    model: Type.Object(
      {
        file: fileName,
        sha256,
        sizeBytes: Type.Integer({ minimum: 1 }),
        repository: Type.String({ minLength: 1 }),
        revision: Type.String({ pattern: "^[a-f0-9]{40}$" }),
        license: Type.Literal("Apache-2.0"),
        nativeDimensions: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    encoding: Type.Object(
      {
        dimensions: Type.Integer({ minimum: 1 }),
        contextTokens: Type.Integer({ minimum: 2 }),
        batchTokens: Type.Integer({ minimum: 1 }),
        threads: Type.Integer({ minimum: 1 }),
        queryInstruction: Type.String({ minLength: 1 }),
        pooling: Type.Literal("last"),
        normalization: Type.Literal("l2"),
        parseSpecial: Type.Literal(false),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type LocalEmbeddingManifest = Static<
  typeof LocalEmbeddingManifestSchema
>;
export interface LocalEmbeddingResources {
  readonly directory: string;
  readonly modelFile: string;
  readonly modelKey: string;
  readonly nativeDimensions: number;
  readonly dimensions: number;
  readonly contextTokens: number;
  readonly batchTokens: number;
  readonly threads: number;
  readonly queryInstruction: string;
}

export async function localEmbeddingResources(input: {
  appPath: string;
  resourcesPath: string;
  isPackaged: boolean;
}): Promise<LocalEmbeddingResources> {
  const directory = input.isPackaged
    ? path.join(input.resourcesPath, "local-embedding")
    : path.join(input.appPath, "resources", "generated", "local-embedding");
  return resolveLocalEmbeddingResources(directory);
}

export async function resolveLocalEmbeddingResources(
  directory: string,
): Promise<LocalEmbeddingResources> {
  const manifest = parseSchema(
    LocalEmbeddingManifestSchema,
    JSON.parse(
      await readFile(path.join(directory, "manifest.json"), "utf8"),
    ) as unknown,
  );
  if (
    process.platform !== manifest.platform ||
    process.arch !== manifest.architecture
  )
    throw new Error(
      "Packaged local embedding resources do not support this platform",
    );
  if (manifest.encoding.dimensions > manifest.model.nativeDimensions)
    throw new Error("Embedding dimensions exceed the model output");
  if (manifest.encoding.batchTokens > manifest.encoding.contextTokens)
    throw new Error("Embedding batch allocation exceeds its context");
  // Preparation verifies source hashes. Do not hash multi-GB weights on Main at every launch.
  // Signing may change native binaries; the model itself must retain its verified byte length.
  const model = await stat(path.join(directory, manifest.model.file));
  if (!model.isFile() || model.size !== manifest.model.sizeBytes)
    throw new Error("Local embedding model is missing or incomplete");
  await Promise.all(
    ["embedding-supervisor", "llama-server"].map(async (file) => {
      const target = path.join(directory, file);
      if (!(await stat(target)).isFile())
        throw new Error("Local embedding executable is missing");
      await access(target, constants.X_OK);
    }),
  );
  // Namespace includes every semantic encoding choice, but not scheduling allocations.
  const modelKey = `qwen3:${createHash("sha256")
    .update(
      JSON.stringify({
        model: manifest.model.sha256,
        engine: manifest.engine.commit,
        nativeDimensions: manifest.model.nativeDimensions,
        dimensions: manifest.encoding.dimensions,
        instruction: manifest.encoding.queryInstruction,
        contextTokens: manifest.encoding.contextTokens,
        pooling: manifest.encoding.pooling,
        normalization: manifest.encoding.normalization,
        parseSpecial: manifest.encoding.parseSpecial,
      }),
    )
    .digest("hex")}`;
  return {
    directory: path.resolve(directory),
    modelFile: manifest.model.file,
    modelKey,
    nativeDimensions: manifest.model.nativeDimensions,
    dimensions: manifest.encoding.dimensions,
    contextTokens: manifest.encoding.contextTokens,
    batchTokens: manifest.encoding.batchTokens,
    threads: manifest.encoding.threads,
    queryInstruction: manifest.encoding.queryInstruction,
  };
}
