import { KEYTAR_ACCOUNT, KEYTAR_SERVICE } from "../constants.ts";
import type { KeytarStore } from "../types.ts";

async function getKeytar(): Promise<KeytarStore> {
  const imported = await import("keytar");
  const module = imported.default ?? imported;
  return module as KeytarStore;
}

export class CredentialStore {
  async load(): Promise<string | undefined> {
    const environmentKey = process.env.CLICKUP_API_KEY?.trim();
    if (environmentKey) return environmentKey;

    try {
      const stored = await (await getKeytar()).getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
      return stored?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async save(value: string): Promise<void> {
    try {
      await (await getKeytar()).setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, value);
    } catch {
      // Keep the credential available for this session if the OS store is unavailable.
    }
  }

  async delete(): Promise<boolean> {
    try {
      return await (await getKeytar()).deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
    } catch {
      return false;
    }
  }

  hasEnvironmentCredential(): boolean {
    return Boolean(process.env.CLICKUP_API_KEY?.trim());
  }
}
