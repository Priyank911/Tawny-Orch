# Configure Google sign-in

Tawny uses Google OAuth in the system browser and Firebase Authentication to establish the app account. The desktop app is a public OAuth client. Google issues a client ID and a client secret for the Desktop OAuth client, and the current Google token endpoint requires the generated secret in the authorization-code exchange (the screenshot error `client_secret is missing` is that exchange). **A desktop OAuth client secret is not confidential:** Google documents that installed apps cannot keep it secret, so it is compiled into the desktop app and can be extracted. It is not equivalent to a server-side secret and does not make the app private. Do not add Firebase service-account credentials or any server-only key to this desktop app.

## Firebase and Google Cloud setup

1. Open the Firebase project that will own Tawny accounts. In **Authentication → Sign-in method**, enable **Google** and choose the support email shown on Google's consent screen.
2. In **Project settings → General**, register a Firebase Web app if needed and copy its **Web API key**. Tawny calls Firebase's Identity Toolkit and Secure Token endpoints directly; it does not embed an Admin SDK credential.
3. In Google Cloud Console for the same Firebase project, configure the OAuth consent screen (app name, support email, and developer contact). If the app remains in Testing, add each test account to the test-user list.
4. Create an OAuth client with application type **Desktop app**. Copy both the client ID and the generated client secret. You do not need a paid Google Workspace account for this.
5. Copy `.env.example` to `.env` in the repository root and set:

   ```dotenv
   TAWNY_FIREBASE_API_KEY=your-firebase-web-api-key
   TAWNY_GOOGLE_CLIENT_ID=your-desktop-client-id.apps.googleusercontent.com
   TAWNY_GOOGLE_CLIENT_SECRET=your-desktop-oauth-client-secret
   ```

6. Restart `pnpm dev` or rebuild the package after changing `.env`; Vite injects these values at build time. The generated app needs these same two variables in the release build environment.

Google's desktop OAuth flow uses a random-port loopback callback bound to `127.0.0.1`. Tawny starts a temporary local callback, opens the Google authorization page using the system browser, verifies the OAuth `state`, and uses PKCE before exchanging the authorization code. No fixed redirect URI or custom tawny:// protocol registration is required.

## Release builds

Add `TAWNY_FIREBASE_API_KEY` and `TAWNY_GOOGLE_CLIENT_ID` as GitHub Actions Variables and `TAWNY_GOOGLE_CLIENT_SECRET` as an Actions Secret. The release workflow requires these values before packaging. Although a desktop OAuth client secret is extractable from any distributed native app and must not be treated as a security boundary, store the source value as an Actions Secret to avoid accidental log exposure. For local builds, keep it in ignored `.env`; never commit `.env`. Set all three values before `pnpm build` and packaging.

When a required value is missing, Tawny displays a configuration message rather than a blank screen or a misleading sign-in failure. There is no hidden fallback provider: Google sign-in requires a configured Firebase project and network access.

## Session storage and recovery

Firebase refresh tokens are encrypted by Electron `safeStorage`, which delegates to the operating system credential facility (Windows DPAPI, macOS Keychain, or Linux Secret Service/libsecret). Only the main process reads or refreshes the token; the renderer receives the account profile and session state. If encryption is unavailable (commonly Linux without a desktop keyring), login remains available for the current app session and the UI explains that it will not survive restart. A network failure during startup can use the cached account locally and offers a **Retry verification** action; an expired or revoked Firebase refresh token returns the app to sign-in.

Google account selection, consent-screen publication/testing status, Firebase provider enablement, network access, and OS keychain availability are controlled by the operator and device. Tawny cannot verify these external settings from a build.
