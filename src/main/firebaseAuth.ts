import { createServer, type Server } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { URL, URLSearchParams } from 'node:url';
import { authStateSchema, authUserSchema, type AuthState, type AuthUser } from '../shared/contracts';
import { atomicWriteFile, isMissingFile, withStorageLock } from './storage';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FIREBASE_IDP_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp';
const FIREBASE_REFRESH_URL = 'https://securetoken.googleapis.com/v1/token';
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

type AuthSecrets = { refreshToken: string; user: AuthUser };
type TokenResponse = {
  id_token?: unknown;
  refresh_token?: unknown;
  idToken?: unknown;
  refreshToken?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
  localId?: unknown;
  email?: unknown;
  displayName?: unknown;
  photoUrl?: unknown;
};

export interface FirebaseAuthDependencies {
  apiKey: string;
  googleClientId: string;
  googleClientSecret: string;
  userDataDir: string;
  encryptionAvailable: () => boolean;
  encrypt: (value: string) => Buffer;
  decrypt: (value: Buffer) => string;
  openExternal: (url: string) => Promise<void>;
  /** Test seam for exercising the token exchange without opening a real browser. */
  getAuthorizationCode?: () => Promise<{ code: string; verifier: string; redirectUri: string }>;
  fetcher?: typeof fetch;
  onState?: (state: AuthState) => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function encodeBase64Url(value: Buffer): string {
  return value.toString('base64url');
}

function isConfigured(config: FirebaseAuthDependencies): boolean {
  return Boolean(config.apiKey.trim() && config.googleClientId.trim() && config.googleClientSecret.trim());
}

function secretsPath(config: FirebaseAuthDependencies): string {
  return join(config.userDataDir, 'auth-session.bin');
}

function safePhotoUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'lh3.googleusercontent.com' || url.hostname.endsWith('.googleusercontent.com'))
      ? url.toString()
      : undefined;
  } catch { return undefined; }
}

function readOAuthError(data: unknown): string | undefined {
  if (!isObject(data)) return undefined;
  const raw = typeof data.error === 'string' ? data.error : '';
  const details = typeof data.error_description === 'string' ? data.error_description : '';
  if (raw === 'access_denied') return 'Google sign-in was cancelled. Choose Continue with Google to try again.';
  return raw ? `Google sign-in could not finish (${raw}${details ? `: ${details}` : ''}).` : undefined;
}

async function readJsonResponse(response: Response): Promise<TokenResponse> {
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new Error('The sign-in service returned an unreadable response. Try again in a moment.'); }
  if (!isObject(value)) throw new Error('The sign-in service returned an unexpected response.');
  const providerMessage = readOAuthError(value);
  if (!response.ok || providerMessage) {
    const rawError = value.error;
    const errorCode = typeof rawError === 'string' ? rawError
      : isObject(rawError) && typeof rawError.message === 'string' ? rawError.message : '';
    const detail = typeof value.error_description === 'string' ? value.error_description : '';
    throw new Error(providerMessage ?? `Firebase sign-in failed${errorCode ? ` (${errorCode})` : ''}${detail ? `: ${detail}` : ''}.`);
  }
  return value as TokenResponse;
}

function isSessionExpired(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /INVALID_REFRESH_TOKEN|TOKEN_EXPIRED|USER_DISABLED|USER_NOT_FOUND|INVALID_GRANT|CREDENTIAL_MISMATCH/i.test(message);
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Browser and test clients can keep an idle HTTP connection alive after
    // the one-shot callback has completed. This listener is never reused.
    server.closeAllConnections();
  });
}

export function createFirebaseAuthService(deps: FirebaseAuthDependencies): {
  getState: () => AuthState;
  initialize: () => Promise<AuthState>;
  signIn: () => Promise<AuthState>;
  cancelSignIn: () => Promise<void>;
  signOut: () => Promise<AuthState>;
  isAuthenticated: () => boolean;
  hasConfiguration: () => boolean;
  hasSecureStorage: () => boolean;
} {
  const fetcher = deps.fetcher ?? fetch;
  let state = authStateSchema.parse({ status: isConfigured(deps) ? 'checking' : 'unconfigured' });
  let refreshToken: string | undefined;
  let activeServer: Server | undefined;
  let cancelActiveSignIn: (() => void) | undefined;

  function publish(next: AuthState): AuthState {
    state = authStateSchema.parse(next);
    deps.onState?.(state);
    return state;
  }

  function hasSecureStorage(): boolean {
    try { return deps.encryptionAvailable(); } catch { return false; }
  }

  function isAuthenticated(): boolean {
    return state.status === 'authenticated' || state.status === 'offline';
  }

  async function readSecrets(): Promise<AuthSecrets | undefined> {
    if (!hasSecureStorage()) return undefined;
    try {
      const encrypted = await readFile(secretsPath(deps));
      const parsed: unknown = JSON.parse(deps.decrypt(encrypted));
      if (!isObject(parsed) || typeof parsed.refreshToken !== 'string' || parsed.refreshToken.length === 0) return undefined;
      return { refreshToken: parsed.refreshToken, user: authUserSchema.parse(parsed.user) };
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw new Error('Tawny could not unlock your saved Google sign-in from the operating-system credential store. Sign in again to replace it.', { cause: error });
    }
  }

  async function saveSession(token: string, user: AuthUser): Promise<boolean> {
    if (!hasSecureStorage()) {
      refreshToken = token;
      return false;
    }
    const file = secretsPath(deps);
    await withStorageLock(file, async () => {
      const encrypted = deps.encrypt(JSON.stringify({ refreshToken: token, user } satisfies AuthSecrets));
      await atomicWriteFile(file, encrypted);
    });
    refreshToken = token;
    return true;
  }

  async function clearSavedSession(): Promise<void> {
    const file = secretsPath(deps);
    await withStorageLock(file, async () => {
      await rm(file, { force: true });
    });
    refreshToken = undefined;
  }

  async function refreshFirebaseSession(token: string): Promise<{ idToken: string; refreshToken: string }> {
    const endpoint = new URL(FIREBASE_REFRESH_URL);
    endpoint.searchParams.set('key', deps.apiKey);
    const response = await fetcher(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const payload = await readJsonResponse(response);
    if (typeof payload.id_token !== 'string' || typeof payload.refresh_token !== 'string') {
      throw new Error('Firebase did not return a usable session. Sign in again.');
    }
    return { idToken: payload.id_token, refreshToken: payload.refresh_token };
  }

  async function initialize(): Promise<AuthState> {
    if (!isConfigured(deps)) return publish({ status: 'unconfigured', persistentSession: false,
      message: 'Google sign-in is not configured for this build. Set the Firebase Web API key, Google Desktop OAuth client ID, and its generated client secret, then rebuild.' });
    let secrets: AuthSecrets | undefined;
    try { secrets = await readSecrets(); }
    catch (error) {
      return publish({ status: 'signed_out', persistentSession: false,
        message: error instanceof Error ? error.message : 'The saved sign-in could not be opened. Sign in again.' });
    }
    if (!secrets?.refreshToken) return publish({ status: 'signed_out', persistentSession: false });
    const user = secrets.user;
    try {
      const refreshed = await refreshFirebaseSession(secrets.refreshToken);
      const persisted = await saveSession(refreshed.refreshToken, user);
      return publish({ status: 'authenticated', user, persistentSession: persisted });
    } catch (error) {
      if (isSessionExpired(error)) {
        await clearSavedSession();
        return publish({ status: 'signed_out', persistentSession: false,
          message: 'Your Google session has expired or was disabled. Sign in again to continue.' });
      }
      refreshToken = secrets.refreshToken;
      return publish({ status: 'offline', user, persistentSession: true,
        message: 'Tawny could not reach Firebase to refresh your session. Local workspace features remain available; reconnect and retry to verify the account.' });
    }
  }

  async function runGoogleOAuth(): Promise<{ code: string; verifier: string; redirectUri: string }> {
    const server = createServer();
    activeServer = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      await closeServer(server);
      throw new Error('Could not reserve a local sign-in callback. Restart Tawny and try again.');
    }
    const redirectUri = `http://127.0.0.1:${address.port}`;
    const stateValue = encodeBase64Url(randomBytes(32));
    const verifier = encodeBase64Url(randomBytes(48));
    const challenge = encodeBase64Url(createHash('sha256').update(verifier).digest());
    const authUrl = new URL(GOOGLE_AUTH_URL);
    authUrl.search = new URLSearchParams({
      client_id: deps.googleClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: stateValue,
      prompt: 'select_account'
    }).toString();

    try {
      await deps.openExternal(authUrl.toString());
      const params = await new Promise<URLSearchParams>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, value?: URLSearchParams) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          cancelActiveSignIn = undefined;
          if (error) reject(error); else resolve(value!);
        };
        const timeout = setTimeout(() => finish(new Error('Google sign-in timed out. Return to Tawny and try again.')), SIGN_IN_TIMEOUT_MS);
        cancelActiveSignIn = () => finish(new Error('Google sign-in was cancelled. Choose Continue with Google to try again.'));
        server.on('request', (request, response) => {
          const remote = request.socket.remoteAddress ?? '';
          const safeRemote = remote === '127.0.0.1' || remote === '::ffff:127.0.0.1' || remote === '::1';
          const host = request.headers.host ?? '';
          if (!safeRemote || host !== `127.0.0.1:${address.port}` || request.method !== 'GET') {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('Return to Tawny Orch to finish sign-in.');
            return;
          }
          const callback = new URL(request.url ?? '/', redirectUri);
          const params = callback.searchParams;
          if (callback.pathname !== '/' || !params.has('state')) {
            response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('This sign-in response could not be verified. Return to Tawny Orch and try again.');
            return;
          }
          const receivedState = params.get('state') ?? '';
          const expected = Buffer.from(stateValue);
          const received = Buffer.from(receivedState);
          if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
            response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('This sign-in response could not be verified. Return to Tawny Orch and try again.');
            finish(new Error('Google sign-in verification failed. Start sign-in again.'));
            return;
          }
          const denied = params.get('error');
          const code = params.get('code');
          if (denied) {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end('<!doctype html><title>Sign-in not completed</title><p>Sign-in was not completed. Return to Tawny Orch to try again.</p>');
            finish(new Error(readOAuthError({ error: denied }) ?? 'Google sign-in was not completed.'));
            return;
          }
          if (!code || code.length > 4096) {
            response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('Google did not return a sign-in code. Return to Tawny Orch and try again.');
            finish(new Error('Google did not return a sign-in code. Try again.'));
            return;
          }
          response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Pragma': 'no-cache',
            'Referrer-Policy': 'no-referrer',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
          }).end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Back to Tawny Orch</title><p>You are signed in. Return to Tawny Orch to continue.</p><script>history.replaceState(null,"","/")</script>');
          params.set('code_verifier', verifier);
          finish(undefined, params);
        });
      });
      const code = params.get('code');
      if (!code) throw new Error('Google returned an incomplete sign-in response. Start again.');
      return { code, verifier, redirectUri };
    } finally {
      cancelActiveSignIn = undefined;
      if (activeServer === server) activeServer = undefined;
      await closeServer(server);
    }
  }

  async function signIn(): Promise<AuthState> {
    if (!isConfigured(deps)) return initialize();
    if (state.status === 'signing_in') return state;
    publish({ status: 'signing_in', persistentSession: false,
      message: 'Google will open in your system browser. Finish there and return to Tawny Orch.' });
    try {
      const { code, verifier, redirectUri } = deps.getAuthorizationCode
        ? await deps.getAuthorizationCode()
        : await runGoogleOAuth();
      const googleResponse = await fetcher(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: deps.googleClientId, client_secret: deps.googleClientSecret,
          grant_type: 'authorization_code', redirect_uri: redirectUri, code_verifier: verifier
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      const googleTokens = await readJsonResponse(googleResponse);
      if (typeof googleTokens.id_token !== 'string') throw new Error('Google did not return an identity token. Check the Desktop OAuth client configuration.');

      const firebaseEndpoint = new URL(FIREBASE_IDP_URL);
      firebaseEndpoint.searchParams.set('key', deps.apiKey);
      const firebaseResponse = await fetcher(firebaseEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          postBody: new URLSearchParams({ id_token: googleTokens.id_token, providerId: 'google.com' }).toString(),
          requestUri: redirectUri,
          returnIdpCredential: true,
          returnSecureToken: true
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      const firebaseTokens = await readJsonResponse(firebaseResponse);
      // Firebase Identity Toolkit uses camelCase (`idToken`, `refreshToken`),
      // unlike Google's OAuth token endpoint and Firebase Secure Token endpoint.
      const firebaseIdToken = firebaseTokens.idToken ?? firebaseTokens.id_token;
      const firebaseRefreshToken = firebaseTokens.refreshToken ?? firebaseTokens.refresh_token;
      if (typeof firebaseIdToken !== 'string' || typeof firebaseRefreshToken !== 'string' || typeof firebaseTokens.localId !== 'string') {
        throw new Error('Firebase accepted Google sign-in but did not return a complete Tawny session. Check Firebase Authentication settings.');
      }
      const user = authUserSchema.parse({
        uid: firebaseTokens.localId,
        email: typeof firebaseTokens.email === 'string' ? firebaseTokens.email : '',
        displayName: typeof firebaseTokens.displayName === 'string' && firebaseTokens.displayName ? firebaseTokens.displayName : 'Google user',
        photoUrl: safePhotoUrl(firebaseTokens.photoUrl)
      });
      const persisted = await saveSession(firebaseRefreshToken, user);
      return publish({
        status: 'authenticated', user, persistentSession: persisted,
        message: persisted ? undefined : 'Signed in for this app session. Enable the operating-system keychain to stay signed in after restart.'
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = /cancelled|timed out/i.test(message);
      return publish({ status: cancelled ? 'signed_out' : 'error', persistentSession: false, message });
    }
  }

  async function cancelSignIn(): Promise<void> {
    cancelActiveSignIn?.();
    if (activeServer) await closeServer(activeServer);
    if (state.status === 'signing_in') publish({ status: 'signed_out', persistentSession: false,
      message: 'Sign-in cancelled. Choose Continue with Google when you are ready.' });
  }

  async function signOut(): Promise<AuthState> {
    await cancelSignIn();
    await clearSavedSession();
    return publish({ status: isConfigured(deps) ? 'signed_out' : 'unconfigured', persistentSession: false,
      message: 'You are signed out of Tawny Orch on this device.' });
  }

  return { getState: () => state, initialize, signIn, cancelSignIn, signOut, isAuthenticated,
    hasConfiguration: () => isConfigured(deps), hasSecureStorage };
}
