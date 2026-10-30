# Tawny Orch Windows early preview — install notes

The release workflow publishes **Windows x64 only** when a matching `vX.Y.Z` tag is pushed. Installers are unsigned early previews. Download only from the official [Tawny Orch GitHub Releases](https://github.com/Priyank911/Tawny-Orch/releases) page and verify the SHA-256 checksum before installation. A matching checksum confirms the downloaded bytes match the release asset; it does not identify the publisher or certify the software.

## Install on Windows 10 or 11

1. Download `Tawny-Orch-*-win-x64.exe` and `SHA256SUMS.txt` from the same release.
2. In PowerShell, run `Get-FileHash .\Tawny-Orch-*-win-x64.exe -Algorithm SHA256` and compare its hash with the installer line in `SHA256SUMS.txt`.
3. Run the installer. Since the app is not code signed, Windows may show an unknown-publisher or SmartScreen warning. Continue only when you chose the official release and verified its checksum.

## Update Tawny

The installed Windows app checks the public GitHub release feed at startup and about once a day. It shows a badge on the profile button and can show a Windows notification while hidden. Open the profile menu or the update notice and choose **Download update**. Tawny verifies the installer download, shows progress, waits for active agent runs to finish, then closes cleanly, installs, and reopens itself. If a download or installation fails, Tawny keeps the current installation and shows an error with a link to the official release page.

The update manifest carries an SHA-512 digest that electron-updater checks before applying the downloaded installer. The release also includes `SHA256SUMS.txt` for manual download verification.

## Publish a release (maintainers)

1. Set the app version in `package.json`, update `pnpm-lock.yaml` with `pnpm install`, and commit/push the change.
2. Configure the GitHub Actions variables `TAWNY_FIREBASE_API_KEY` and `TAWNY_GOOGLE_CLIENT_ID`, and the secret `TAWNY_GOOGLE_CLIENT_SECRET` as described in [Google authentication setup](GOOGLE-AUTH-SETUP.md).
3. Push a tag matching the version, for example `git tag v0.1.1; git push origin v0.1.1`.
4. The Windows workflow runs typecheck, the full test suite, build and NSIS packaging, then publishes the installer, update manifest, blockmap, notes, and SHA-256 checksums as a GitHub prerelease.

Every release is an unsigned preview. Signing the installer remains a separate future distribution step.
