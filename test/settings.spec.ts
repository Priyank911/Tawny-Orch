import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appSettingsSchema } from '../src/shared/contracts';

const electron = vi.hoisted(() => ({
  userData: '', available: true, backend: 'dpapi',
  encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`)),
  decryptString: vi.fn((value: Buffer) => {
    const text = value.toString();
    if (!text.startsWith('encrypted:')) throw new Error('invalid ciphertext');
    return Buffer.from(text.slice('encrypted:'.length), 'base64').toString();
  })
}));
vi.mock('electron', () => ({
  app: { getPath: () => electron.userData },
  safeStorage: {
    isEncryptionAvailable: () => electron.available,
    getSelectedStorageBackend: () => electron.backend,
    encryptString: electron.encryptString,
    decryptString: electron.decryptString
  }
}));
import { readSettings, saveSettings } from '../src/main/settings';

let root: string;
const credentials = () => join(electron.userData, 'credentials.bin');
const preferences = () => join(electron.userData, 'preferences.json');
const defaults = () => appSettingsSchema.parse({});
const withSecrets = () => appSettingsSchema.parse({ groqApiKey: 'secret-groq', cloudflareAccountId: 'private-account', cloudflareApiToken: 'secret-cloudflare' });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tawny-settings-'));
  electron.userData = join(root, '用户 café', 'fresh');
  electron.available = true;
  electron.backend = 'dpapi';
  electron.encryptString.mockClear();
  electron.decryptString.mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('encrypted settings', () => {
  it('reads defaults on a fresh installation', async () => {
    expect(await readSettings()).toEqual(defaults());
  });

  it('creates Unicode directories and round trips encrypted credentials and preferences', async () => {
    const settings = withSecrets();
    settings.prefs.alwaysRoute = true;
    await saveSettings(settings);
    expect(await readSettings()).toEqual(settings);
    expect(electron.encryptString).toHaveBeenCalledOnce();
    const bytes = await readFile(credentials());
    expect(bytes.toString()).not.toContain(settings.groqApiKey);
    expect(bytes.toString()).not.toMatch(/^plaintext:/);
    const plain = await readFile(preferences(), 'utf8');
    for (const secret of [settings.groqApiKey, settings.cloudflareAccountId, settings.cloudflareApiToken]) expect(plain).not.toContain(secret);
    expect(await readdir(electron.userData)).toEqual(['credentials.bin', 'preferences.json']);
  });

  it.each(['groqApiKey', 'cloudflareAccountId', 'cloudflareApiToken'] as const)('fails clearly without encryption for %s', async (key) => {
    electron.available = false;
    const settings = defaults();
    settings[key] = 'do-not-write';
    await expect(saveSettings(settings)).rejects.toThrow('Secure encryption is unavailable');
    expect(electron.encryptString).not.toHaveBeenCalled();
    await expect(readFile(credentials())).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(preferences())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects the basic_text backend even if Electron reports encryption available', async () => {
    electron.backend = 'basic_text';
    await expect(saveSettings(withSecrets())).rejects.toThrow('Secure encryption is unavailable');
  });

  it('persists nonsecret preferences on a fresh install without encryption', async () => {
    electron.available = false;
    const settings = defaults();
    settings.prefs.hotkey = 'Control+Shift+Space';
    settings.prefs.wakePhrases = ['你好 tawny'];
    await saveSettings(settings);
    expect(await readSettings()).toEqual(settings);
    expect(await readdir(electron.userData)).toEqual(['preferences.json']);
  });

  it('preserves encrypted bytes through unavailable reads and preference-only saves', async () => {
    const original = withSecrets();
    await saveSettings(original);
    const bytes = await readFile(credentials());
    electron.available = false;
    const locked = await readSettings();
    expect(locked.groqApiKey).toBe('');
    locked.prefs.alwaysRoute = true;
    await saveSettings(locked);
    expect(await readFile(credentials())).toEqual(bytes);
    await expect(saveSettings(original)).rejects.toThrow('Secure encryption is unavailable');
    expect(await readFile(credentials())).toEqual(bytes);
    electron.available = true;
    expect(await readSettings()).toEqual({ ...original, prefs: locked.prefs });
  });

  it('reads legacy encrypted files and retains their preferences when migrated', async () => {
    const original = withSecrets();
    original.prefs.alwaysRoute = true;
    await mkdir(electron.userData, { recursive: true });
    await writeFile(credentials(), electron.encryptString(JSON.stringify(original)));
    expect(await readSettings()).toEqual(original);
    await saveSettings(await readSettings());
    expect(await readSettings()).toEqual(original);
  });

  it('does not replace corrupt or legacy plaintext credentials with blank values', async () => {
    await mkdir(electron.userData, { recursive: true });
    const legacy = `plaintext:${JSON.stringify(withSecrets())}`;
    await writeFile(credentials(), legacy);
    await expect(readSettings()).rejects.toThrow('Cannot decrypt saved settings');
    await expect(saveSettings(defaults())).rejects.toThrow('existing credentials have not been overwritten');
    expect(await readFile(credentials(), 'utf8')).toBe(legacy);
  });

  it('preserves existing values if encryption throws', async () => {
    await saveSettings(withSecrets());
    const before = await readFile(credentials());
    electron.encryptString.mockImplementationOnce(() => { throw new Error('keychain locked'); });
    await expect(saveSettings(defaults())).rejects.toThrow('keychain locked');
    expect(await readFile(credentials())).toEqual(before);
    expect((await readSettings()).groqApiKey).toBe('secret-groq');
  });

  it('allows explicitly clearing credentials when encryption is working', async () => {
    await saveSettings(withSecrets());
    await saveSettings(defaults());
    expect(await readSettings()).toEqual(defaults());
  });

  it('serializes simultaneous saves so preferences and credentials match', async () => {
    const settings = Array.from({ length: 12 }, (_, index) => {
      const value = defaults();
      value.groqApiKey = `key-${index}`;
      value.prefs.wakePhrases = [`phrase-${index}`];
      return value;
    });
    await Promise.all(settings.map(saveSettings));
    expect(await readSettings()).toEqual(settings[11]);
  });

  it('does not silently reset malformed preferences', async () => {
    await saveSettings(withSecrets());
    await writeFile(preferences(), 'broken');
    await expect(readSettings()).rejects.toThrow('Cannot read saved preferences');
    expect(await readFile(preferences(), 'utf8')).toBe('broken');
  });
});
