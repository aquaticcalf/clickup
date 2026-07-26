import { KEYTAR_ACCOUNT, KEYTAR_SERVICE } from "../constants.ts"

type KeytarStore = {
  getPassword(service: string, account: string): Promise<string | null>
  setPassword(service: string, account: string, password: string): Promise<void>
  deletePassword(service: string, account: string): Promise<boolean>
}

async function getKeytar(): Promise<KeytarStore> {
  const imported = await import("keytar")
  return (imported.default ?? imported) as KeytarStore
}

export class CredentialStore {
  async load(): Promise<string | undefined> {
    try {
      const value = await (await getKeytar()).getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT)
      return value?.trim() || undefined
    } catch {
      return undefined
    }
  }

  async save(value: string): Promise<boolean> {
    try {
      await (await getKeytar()).setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, value)
      return true
    } catch {
      return false
    }
  }

  async delete(): Promise<boolean> {
    try {
      return await (await getKeytar()).deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT)
    } catch {
      return false
    }
  }
}
