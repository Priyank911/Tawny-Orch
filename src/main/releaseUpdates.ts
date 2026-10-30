import type { AppUpdateState } from '../shared/contracts';

export const RELEASE_REPOSITORY = 'Priyank911/Tawny-Orch';
export const RELEASES_URL = `https://github.com/${RELEASE_REPOSITORY}/releases`;
const RELEASE_API = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases?per_page=20`;

interface GithubRelease {
  draft?: unknown;
  tag_name?: unknown;
  name?: unknown;
  html_url?: unknown;
  body?: unknown;
  published_at?: unknown;
}

function parseVersion(value: string): { core: number[]; prerelease: string[] } | undefined {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return undefined;
  return { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') ?? [] };
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  if (!next || !installed) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next.core[index] !== installed.core[index]) return next.core[index] > installed.core[index];
  }
  if (!next.prerelease.length || !installed.prerelease.length) return !next.prerelease.length && installed.prerelease.length > 0;
  const length = Math.max(next.prerelease.length, installed.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const left = next.prerelease[index];
    const right = installed.prerelease[index];
    if (left === undefined || right === undefined) return left === undefined && right !== undefined;
    if (left === right) continue;
    const leftNumber = /^\d+$/.test(left) ? Number(left) : undefined;
    const rightNumber = /^\d+$/.test(right) ? Number(right) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber > rightNumber;
    if (leftNumber !== undefined) return true;
    if (rightNumber !== undefined) return false;
    return left > right;
  }
  return false;
}

export async function checkForReleaseUpdate(
  currentVersion: string,
  fetcher: typeof fetch = fetch,
  checkedAt = new Date().toISOString()
): Promise<AppUpdateState> {
  const base = { currentVersion, checkedAt, version: '', releaseNotes: '' };
  try {
    const response = await fetcher(RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Tawny-Orch-Update-Checker' },
      signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);
    const releases: unknown = await response.json();
    if (!Array.isArray(releases)) throw new Error('GitHub returned an unexpected releases response.');
    const release = releases.find((item): item is GithubRelease => Boolean(item) && typeof item === 'object' &&
      (item as GithubRelease).draft !== true && typeof (item as GithubRelease).tag_name === 'string' &&
      typeof (item as GithubRelease).html_url === 'string' && (item as GithubRelease).published_at != null) as GithubRelease | undefined;
    if (!release) {
      return { ...base, status: 'current', message: 'No published Tawny preview releases are available yet.' };
    }
    const version = String(release.tag_name).replace(/^v/, '');
    const releaseUrl = new URL(String(release.html_url));
    if (releaseUrl.protocol !== 'https:' || releaseUrl.hostname !== 'github.com' ||
        !releaseUrl.pathname.startsWith(`/${RELEASE_REPOSITORY}/releases/`)) {
      throw new Error('The release link did not match the official Tawny GitHub repository.');
    }
    if (!parseVersion(version)) throw new Error(`Release tag “${release.tag_name}” is not a valid semantic version.`);
    if (!isNewerVersion(version, currentVersion)) return { ...base, status: 'current' };
    return {
      ...base,
      status: 'available',
      version,
      releaseUrl: releaseUrl.toString(),
      releaseNotes: typeof release.body === 'string' ? release.body.slice(0, 12_000) : '',
      publishedAt: typeof release.published_at === 'string' ? release.published_at : undefined,
      message: `Tawny Orch ${version} is available.`
    };
  } catch (error) {
    return {
      ...base,
      status: 'error',
      message: `Could not check GitHub Releases: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300)
    };
  }
}
