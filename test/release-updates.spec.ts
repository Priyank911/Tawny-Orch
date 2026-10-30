import { describe, expect, it } from 'vitest';
import { checkForReleaseUpdate, isNewerVersion, RELEASES_URL } from '../src/main/releaseUpdates';

function fetchReply(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;
}

describe('release update checks', () => {
  it('compares stable and preview semantic versions correctly', () => {
    expect(isNewerVersion('0.1.1', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.1.0-preview.1')).toBe(true);
    expect(isNewerVersion('0.1.0-preview.3', '0.1.0-preview.2')).toBe(true);
    expect(isNewerVersion('0.1.0-preview.2', '0.1.0-preview.10')).toBe(false);
    expect(isNewerVersion('not-a-version', '0.1.0')).toBe(false);
  });

  it('returns a newer published release from the official repository', async () => {
    const result = await checkForReleaseUpdate('0.1.0', fetchReply([{
      draft: false, tag_name: 'v0.1.1', name: 'Early Preview 0.1.1',
      html_url: `${RELEASES_URL}/tag/v0.1.1`, body: 'Fixes and improvements', published_at: '2026-10-23T00:00:00Z'
    }]), '2026-10-23T00:00:00Z');
    expect(result).toMatchObject({
      status: 'available', currentVersion: '0.1.0', version: '0.1.1',
      releaseUrl: `${RELEASES_URL}/tag/v0.1.1`, releaseNotes: 'Fixes and improvements'
    });
  });

  it('ignores drafts and reports up to date when no newer version exists', async () => {
    const result = await checkForReleaseUpdate('0.1.1', fetchReply([
      { draft: true, tag_name: 'v0.1.2', html_url: `${RELEASES_URL}/tag/v0.1.2` },
      { draft: false, tag_name: 'v0.1.1', html_url: `${RELEASES_URL}/tag/v0.1.1`, published_at: '2026-10-23T00:00:00Z' }
    ]));
    expect(result.status).toBe('current');
  });

  it('rejects unexpected release URLs and reports network failures without crashing the app', async () => {
    const unsafe = await checkForReleaseUpdate('0.1.0', fetchReply([{
      draft: false, tag_name: 'v0.2.0', html_url: 'https://attacker.invalid/releases/tag/v0.2.0', published_at: '2026-10-23T00:00:00Z'
    }]));
    expect(unsafe.status).toBe('error');
    const offline = await checkForReleaseUpdate('0.1.0', (async () => { throw new Error('offline'); }) as typeof fetch);
    expect(offline).toMatchObject({ status: 'error', message: expect.stringContaining('offline') });
  });
});
