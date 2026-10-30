import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFirebaseAuthService } from '../src/main/firebaseAuth';

describe('Firebase Google sign-in service', () => {
  it('completes the PKCE loopback flow and refreshes the encrypted session on restart', async () => {
    const userDataDir = await mkdtemp(join(process.cwd(), '.test-auth-'));
    let refreshCount = 0;
    let currentFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'oauth2.googleapis.com') {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get('code')).toBe('test-code');
        expect(body.get('code_verifier')).toBeTruthy();
        expect(body.get('client_secret')).toBe('desktop-client-secret');
        return Response.json({ id_token: 'google-id-token', refresh_token: 'google-refresh', expires_in: 3600 });
      }
      if (url.hostname === 'identitytoolkit.googleapis.com') {
        const body = JSON.parse(String(init?.body)) as { postBody: string };
        expect(new URLSearchParams(body.postBody).get('providerId')).toBe('google.com');
        expect(new URLSearchParams(body.postBody).get('id_token')).toBe('google-id-token');
        // Firebase Identity Toolkit responds in camelCase. Google OAuth and
        // Firebase Secure Token use snake_case, so test this API separately.
        return Response.json({ idToken: 'firebase-id-token', refreshToken: 'firebase-refresh', localId: 'user-1', email: 'person@example.com', displayName: 'Example Person' });
      }
      if (url.hostname === 'securetoken.googleapis.com') {
        refreshCount += 1;
        return Response.json({ id_token: 'renewed-id-token', refresh_token: 'rotated-refresh-token', expires_in: 3600 });
      }
      throw new Error(`Unexpected auth endpoint: ${url.hostname}`);
    };
    const service = createFirebaseAuthService({
      apiKey: 'firebase-public-key', googleClientId: 'desktop-client.apps.googleusercontent.com', googleClientSecret: 'desktop-client-secret', userDataDir,
      encryptionAvailable: () => true,
      encrypt: (value) => Buffer.from(Buffer.from(value).toString('base64')),
      decrypt: (value) => Buffer.from(value.toString(), 'base64').toString(),
      fetcher: (...args) => currentFetch(...args),
      openExternal: async () => undefined,
      getAuthorizationCode: async () => ({ code: 'test-code', verifier: 'test-pkce-verifier', redirectUri: 'http://127.0.0.1:45678' })
    });

    try {
      const signedIn = await service.signIn();
      expect(signedIn.status, signedIn.message).toBe('authenticated');
      expect(signedIn.user?.email).toBe('person@example.com');
      expect(signedIn.persistentSession).toBe(true);
      expect(await readFile(join(userDataDir, 'auth-session.bin'), 'utf8')).not.toContain('firebase-refresh');

      const restarted = createFirebaseAuthService({
        apiKey: 'firebase-public-key', googleClientId: 'desktop-client.apps.googleusercontent.com', googleClientSecret: 'desktop-client-secret', userDataDir,
        encryptionAvailable: () => true,
        encrypt: (value) => Buffer.from(Buffer.from(value).toString('base64')),
        decrypt: (value) => Buffer.from(value.toString(), 'base64').toString(),
        fetcher: (...args) => currentFetch(...args), openExternal: async () => undefined,
        getAuthorizationCode: async () => ({ code: 'test-code', verifier: 'test-pkce-verifier', redirectUri: 'http://127.0.0.1:45678' })
      });
      const restored = await restarted.initialize();
      expect(restored.status).toBe('authenticated');
      expect(restored.user?.email).toBe('person@example.com');
      expect(refreshCount).toBe(1);
      await restarted.signOut();
      await expect(readFile(join(userDataDir, 'auth-session.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  it('does not claim persistence when the OS credential service is unavailable', async () => {
    const userDataDir = await mkdtemp(join(process.cwd(), '.test-auth-memory-'));
    let fetchCall = 0;
    const service = createFirebaseAuthService({
      apiKey: 'firebase-public-key', googleClientId: 'desktop-client.apps.googleusercontent.com', googleClientSecret: 'desktop-client-secret', userDataDir,
      encryptionAvailable: () => false,
      encrypt: () => { throw new Error('must not encrypt'); }, decrypt: () => { throw new Error('must not decrypt'); },
      fetcher: async (input) => {
        fetchCall += 1;
        const host = new URL(String(input)).hostname;
        if (host === 'oauth2.googleapis.com') return Response.json({ id_token: 'google-id-token' });
        return Response.json({ idToken: 'firebase-id-token', refreshToken: 'firebase-refresh', localId: 'user-1', email: 'person@example.com' });
      },
      openExternal: async () => undefined,
      getAuthorizationCode: async () => ({ code: 'test-code', verifier: 'test-pkce-verifier', redirectUri: 'http://127.0.0.1:45678' })
    });
    try {
      const state = await service.signIn();
      expect(state.status).toBe('authenticated');
      expect(state.persistentSession).toBe(false);
      expect(state.message).toContain('Enable the operating-system keychain');
      expect(fetchCall).toBe(2);
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
});
