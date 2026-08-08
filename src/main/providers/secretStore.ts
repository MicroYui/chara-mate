import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { Type } from "@sinclair/typebox";

import type { IdGenerator } from "../../shared/pure/id";
import { EntityIdSchema } from "../../shared/schemas/primitives";
import { parseSchema } from "../../shared/schemas/validation";
import { ProviderError } from "./providerError";

const SecretFileSchema = Type.Object(
  {
    secrets: Type.Record(
      Type.String(),
      Type.String({ pattern: "^[A-Za-z0-9+/]*={0,2}$" }),
    ),
    version: Type.Literal(1),
  },
  { additionalProperties: false },
);

type SecretFile = {
  secrets: Record<string, string>;
  version: 1;
};

export interface DecryptedSecret {
  readonly result: string;
  readonly shouldReEncrypt: boolean;
}

export interface AsyncSecretEncryption {
  decrypt(encrypted: Buffer): Promise<DecryptedSecret>;
  encrypt(plainText: string): Promise<Buffer>;
  isAvailable(): Promise<boolean>;
}

export interface ProviderSecretStore {
  delete(secretRef: string): Promise<void>;
  get(secretRef: string): Promise<string>;
  prune(allowedReferences: ReadonlySet<string>): Promise<void>;
  store(plainText: string): Promise<string>;
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export class SafeStorageSecretStore implements ProviderSecretStore {
  #queue: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly encryption: AsyncSecretEncryption,
    private readonly idGenerator: IdGenerator,
  ) {}

  delete(secretRef: string): Promise<void> {
    return this.#exclusive(async () => {
      const file = await this.#readFile();
      if (!(secretRef in file.secrets)) {
        return;
      }
      delete file.secrets[secretRef];
      await this.#writeFile(file);
    });
  }

  get(secretRef: string): Promise<string> {
    return this.#exclusive(async () => {
      await this.#assertAvailable();
      const file = await this.#readFile();
      const encoded = file.secrets[secretRef];
      if (!encoded) {
        throw new ProviderError(
          "PROVIDER.CREDENTIAL_REQUIRED",
          "没有可用的凭据。",
          false,
        );
      }

      try {
        const decrypted = await this.encryption.decrypt(
          Buffer.from(encoded, "base64"),
        );
        if (decrypted.shouldReEncrypt) {
          file.secrets[secretRef] = (
            await this.encryption.encrypt(decrypted.result)
          ).toString("base64");
          await this.#writeFile(file);
        }
        return decrypted.result;
      } catch (error) {
        if (error instanceof ProviderError) {
          throw error;
        }
        throw new ProviderError(
          "PROVIDER.STORAGE_FAILED",
          "无法读取系统密钥存储中的凭据。",
          true,
        );
      }
    });
  }

  prune(allowedReferences: ReadonlySet<string>): Promise<void> {
    return this.#exclusive(async () => {
      const file = await this.#readFile();
      let changed = false;
      for (const secretRef of Object.keys(file.secrets)) {
        if (!allowedReferences.has(secretRef)) {
          delete file.secrets[secretRef];
          changed = true;
        }
      }
      if (changed) {
        await this.#writeFile(file);
      }
    });
  }

  store(plainText: string): Promise<string> {
    return this.#exclusive(async () => {
      await this.#assertAvailable();
      const normalized = plainText.trim();
      if (!normalized) {
        throw new ProviderError(
          "PROVIDER.INVALID_CONFIGURATION",
          "凭据不能为空。",
          false,
        );
      }

      try {
        const secretRef = this.idGenerator.generate();
        const encrypted = await this.encryption.encrypt(normalized);
        const file = await this.#readFile();
        file.secrets[secretRef] = encrypted.toString("base64");
        await this.#writeFile(file);
        return secretRef;
      } catch (error) {
        if (error instanceof ProviderError) {
          throw error;
        }
        throw new ProviderError(
          "PROVIDER.STORAGE_FAILED",
          "无法把凭据写入系统密钥存储。",
          true,
        );
      }
    });
  }

  #assertAvailable = async (): Promise<void> => {
    let available: boolean;
    try {
      available = await this.encryption.isAvailable();
    } catch {
      throw new ProviderError(
        "PROVIDER.SECRET_STORAGE_UNAVAILABLE",
        "系统密钥存储暂不可用，请稍后重试。",
        true,
      );
    }
    if (!available) {
      throw new ProviderError(
        "PROVIDER.SECRET_STORAGE_UNAVAILABLE",
        "系统密钥存储暂不可用，请稍后重试。",
        true,
      );
    }
  };

  #exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(task, task);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #readFile(): Promise<SecretFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) {
        return { secrets: {}, version: 1 };
      }
      throw new ProviderError(
        "PROVIDER.STORAGE_FAILED",
        "无法读取加密密钥文件。",
        true,
      );
    }

    try {
      const parsed = parseSchema(SecretFileSchema, JSON.parse(raw));
      for (const secretRef of Object.keys(parsed.secrets)) {
        parseSchema(EntityIdSchema, secretRef);
      }
      return parsed;
    } catch {
      throw new ProviderError(
        "PROVIDER.STORAGE_FAILED",
        "加密密钥文件已损坏，未读取任何凭据。",
        false,
      );
    }
  }

  async #writeFile(file: SecretFile): Promise<void> {
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${this.idGenerator.generate()}.tmp`;
    await mkdir(directory, { mode: 0o700, recursive: true });
    try {
      await writeFile(temporaryPath, JSON.stringify(file), { mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch {
      throw new ProviderError(
        "PROVIDER.STORAGE_FAILED",
        "无法提交加密密钥文件。",
        true,
      );
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
