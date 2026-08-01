import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CryptoIdGenerator } from "../../shared/pure/id";
import type { AsyncSecretEncryption, DecryptedSecret } from "./secretStore";
import { SafeStorageSecretStore } from "./secretStore";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

class FakeEncryption implements AsyncSecretEncryption {
  encryptCount = 0;
  available = true;
  rotateOnNextDecrypt = false;

  decrypt(encrypted: Buffer): Promise<DecryptedSecret> {
    const encoded = encrypted.toString("utf8");
    const result = encoded
      .slice(encoded.indexOf(":") + 1)
      .split("")
      .reverse()
      .join("");
    const shouldReEncrypt = this.rotateOnNextDecrypt;
    this.rotateOnNextDecrypt = false;
    return Promise.resolve({ result, shouldReEncrypt });
  }

  encrypt(plainText: string): Promise<Buffer> {
    this.encryptCount += 1;
    return Promise.resolve(
      Buffer.from(
        `cipher-${String(this.encryptCount)}:${plainText.split("").reverse().join("")}`,
        "utf8",
      ),
    );
  }

  isAvailable(): Promise<boolean> {
    return Promise.resolve(this.available);
  }
}

async function createStore(encryption = new FakeEncryption()) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-secret-store-"),
  );
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "secrets.bin");
  return {
    encryption,
    filePath,
    store: new SafeStorageSecretStore(
      filePath,
      encryption,
      new CryptoIdGenerator(),
    ),
  };
}

describe("async safeStorage-backed secret file", () => {
  it("stores only encrypted bytes, decrypts, rotates and deletes a key", async () => {
    const { encryption, filePath, store } = await createStore();
    const secret = "sk-provider-plain-text-secret";
    const secretRef = await store.store(secret);

    const rawAfterStore = await readFile(filePath);
    expect(rawAfterStore.includes(Buffer.from(secret))).toBe(false);
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }

    encryption.rotateOnNextDecrypt = true;
    await expect(store.get(secretRef)).resolves.toBe(secret);
    expect(encryption.encryptCount).toBe(2);
    expect((await readFile(filePath)).includes(Buffer.from(secret))).toBe(
      false,
    );

    await store.delete(secretRef);
    await expect(store.get(secretRef)).rejects.toMatchObject({
      code: "PROVIDER.CREDENTIAL_REQUIRED",
    });
  });

  it("serializes concurrent writes and prunes orphan references", async () => {
    const { filePath, store } = await createStore();
    const [first, second] = await Promise.all([
      store.store("first-secret"),
      store.store("second-secret"),
    ]);

    await store.prune(new Set([second]));
    await expect(store.get(second)).resolves.toBe("second-secret");
    await expect(store.get(first)).rejects.toMatchObject({
      code: "PROVIDER.CREDENTIAL_REQUIRED",
    });
    const raw = await readFile(filePath, "utf8");
    expect(raw).not.toContain("first-secret");
    expect(raw).not.toContain("second-secret");
  });

  it("treats unavailable encryption and corrupt files as recoverable domain errors", async () => {
    const unavailable = new FakeEncryption();
    unavailable.available = false;
    const unavailableStore = await createStore(unavailable);
    await expect(unavailableStore.store.store("secret")).rejects.toMatchObject({
      code: "PROVIDER.SECRET_STORAGE_UNAVAILABLE",
      retryable: true,
    });

    const corrupt = await createStore();
    await writeFile(corrupt.filePath, "not-json", "utf8");
    await expect(corrupt.store.prune(new Set())).rejects.toMatchObject({
      code: "PROVIDER.STORAGE_FAILED",
      retryable: false,
    });
  });
});
