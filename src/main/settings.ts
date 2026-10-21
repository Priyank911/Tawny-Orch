import { app, safeStorage } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appSettingsSchema, type AppSettings } from '../shared/contracts';
import { atomicWriteFile, isMissingFile, withStorageLock } from './storage';

const settingsPath = (): string => join(app.getPath('userData'), 'credentials.bin');
const preferencesPath = (): string => join(app.getPath('userData'), 'preferences.json');
const preferencesSchema = appSettingsSchema.omit({ groqApiKey: true, cloudflareAccountId: true, cloudflareApiToken: true });

function encryptionAvailable(): boolean {
  // Electron's Linux basic_text backend does not provide secret encryption.
  return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
}

async function credentialsFile(): Promise<Buffer | null> {
  try {
    return await readFile(settingsPath());
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function decryptSettings(encrypted: Buffer): AppSettings {
  try {
    return appSettingsSchema.parse(JSON.parse(safeStorage.decryptString(encrypted)));
  } catch (error) {
    throw new Error('Cannot decrypt saved settings; existing credentials have not been overwritten', { cause: error });
  }
}

async function readPreferences(): Promise<ReturnType<typeof preferencesSchema.parse> | null> {
  try {
    return preferencesSchema.parse(JSON.parse(await readFile(preferencesPath(), 'utf8')));
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw new Error('Cannot read saved preferences', { cause: error });
  }
}

export async function readSettings(): Promise<AppSettings> {
  return withStorageLock(settingsPath(), async () => {
    const encrypted = await credentialsFile();
    const settings = encrypted && encryptionAvailable()
      ? decryptSettings(encrypted)
      : appSettingsSchema.parse({});
    // Older credentials.bin files contain both secrets and preferences.
    return appSettingsSchema.parse({ ...settings, ...await readPreferences() });
  });
}

export async function saveSettings(input: AppSettings): Promise<void> {
  const parsed = appSettingsSchema.parse(input);
  await withStorageLock(settingsPath(), async () => {
    const preferences = preferencesSchema.parse(parsed);
    const secrets = {
      groqApiKey: parsed.groqApiKey,
      cloudflareAccountId: parsed.cloudflareAccountId,
      cloudflareApiToken: parsed.cloudflareApiToken
    };
    if (!encryptionAvailable()) {
      if (Object.values(secrets).some((value) => value.length > 0)) {
        throw new Error('Secure encryption is unavailable; credentials were not saved. Enable the OS keychain and try again.');
      }
      // Blank values returned while locked must never erase existing credentials.
      await atomicWriteFile(preferencesPath(), JSON.stringify(preferences, null, 2));
      return;
    }
    const existing = await credentialsFile();
    if (existing) decryptSettings(existing);
    const encrypted = safeStorage.encryptString(JSON.stringify(secrets));
    await atomicWriteFile(settingsPath(), encrypted);
    await atomicWriteFile(preferencesPath(), JSON.stringify(preferences, null, 2));
  });
}
