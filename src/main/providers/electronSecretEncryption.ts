import { safeStorage } from "electron";

import type { AsyncSecretEncryption, DecryptedSecret } from "./secretStore";

export class ElectronSafeStorageEncryption implements AsyncSecretEncryption {
  async decrypt(encrypted: Buffer): Promise<DecryptedSecret> {
    return safeStorage.decryptStringAsync(encrypted);
  }

  async encrypt(plainText: string): Promise<Buffer> {
    return safeStorage.encryptStringAsync(plainText);
  }

  async isAvailable(): Promise<boolean> {
    return safeStorage.isAsyncEncryptionAvailable();
  }
}
