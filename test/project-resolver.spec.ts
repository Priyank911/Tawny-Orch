import { describe, expect, it } from 'vitest';
import {
  resolveVoiceProject,
  type VoiceProject,
  type VoiceProjectRegistration
} from '../src/main/pipeline/projectResolver';

const atlas: VoiceProjectRegistration = {
  path: 'D:\\approved\\atlas', name: 'Atlas Dashboard', isGit: true,
  aliases: ['atlas', 'atlas dashboard', 'एटलस', 'atlas डैशबोर्ड']
};
const shop: VoiceProjectRegistration = {
  path: 'D:\\approved\\shop', name: 'Shop', aliases: ['shop', 'दुकान', 'my shop']
};
const registrations = [atlas, shop] as const;
const attached: VoiceProject = { path: 'D:\\approved\\attached', name: 'Attached', isGit: false };
const atlasProject = { path: atlas.path, name: atlas.name, isGit: atlas.isGit };

describe('resolveVoiceProject golden transcripts', () => {
  it.each([
    ['Build login in atlas', 'Build login'],
    ['Fix checkout on SHOP', 'Fix checkout'],
    ['In Atlas, Build Login', 'Build Login'],
    ['on atlas: add tests', 'add tests'],
    ['in atlas build a dashboard', 'build a dashboard'],
    ['Build login in atlas with tests', 'Build login with tests'],
    ['एटलस में लॉगिन पेज बनाओ', 'लॉगिन पेज बनाओ'],
    ['लॉगिन पेज बनाओ एटलस में', 'लॉगिन पेज बनाओ'],
    ['atlas mein login page banao', 'login page banao'],
    ['login page banao atlas mein', 'login page banao'],
    ['atlas डैशबोर्ड में Login जोड़ो', 'Login जोड़ो'],
    ['in atlas डैशबोर्ड, लॉगिन जोड़ो', 'लॉगिन जोड़ो'],
    ['in atlas dashboard, fix login', 'fix login'],
    ['in ATLAS, Use Ｆｕｌｌｗｉｄｔｈ Labels', 'Use Ｆｕｌｌｗｉｄｔｈ Labels'],
    ['in ＡＴＬＡＳ, Keep मेरी हिन्दी intact!', 'Keep मेरी हिन्दी intact!'],
    ['in\tAtlas\n, fix login', 'fix login']
  ])('resolves %s without corrupting the goal', (transcript, goal) => {
    const result = resolveVoiceProject(transcript, registrations, attached);
    const expected = transcript.includes('SHOP') ? { path: shop.path, name: shop.name } : atlasProject;
    expect(result).toEqual({ project: expected, goal, needsSelection: false, reason: 'registered-alias' });
    expect(result.project).not.toHaveProperty('aliases');
  });

  it.each(['in atlas', 'on atlas', 'atlas mein', 'एटलस में'])('allows a project-only slot: %s', (transcript) => {
    expect(resolveVoiceProject(transcript, registrations)).toEqual({
      project: atlasProject, needsSelection: false, reason: 'registered-alias'
    });
  });

  it('matches NFKC and canonical equivalents without transliteration or accent stripping', () => {
    const projects = [{ path: '/approved/cafe', name: 'Café', aliases: ['café', 'ﬂow', 'सेवा', 'ος', '𐐨app'] }];
    for (const transcript of ['in cafe\u0301, fix UI', 'in FLOW, fix UI', 'सेवा में fix UI', 'in ΟΣ, fix UI', 'in 𐐀APP, fix UI']) {
      expect(resolveVoiceProject(transcript, projects).project?.path).toBe('/approved/cafe');
    }
    expect(resolveVoiceProject('in cafe, fix UI', projects, attached).reason).toBe('unknown-project');
    expect(resolveVoiceProject('in sewa, fix UI', projects, attached).reason).toBe('unknown-project');
    expect(resolveVoiceProject('in аtlas, fix UI', registrations, attached).reason).toBe('unknown-project'); // Cyrillic а
  });
});

describe('fail-closed explicit project slots', () => {
  it.each([
    'Build login in neptune',
    'on Neptune, add tests',
    'neptune mein login banao',
    'नेपच्यून में लॉगिन बनाओ',
    'build login in atlasmobile',
    'build login in my atlas',
    'build login in atlas mobile',
    'build login in atlas-dashboard',
    'build login in atlas_2',
    'build login in atlasजी',
    'build login in atlas\u093e',
    '𐐀atlas mein fix login',
    'in atlas𐐀, fix login',
    'in atlas and on neptune, fix login',
    'in Atlas Dashboard Pro, fix login'
  ])('never falls back to attached for %s', (transcript) => {
    for (const attachment of [attached, undefined, null]) {
      expect(resolveVoiceProject(transcript, registrations, attachment)).toEqual({
        goal: transcript, needsSelection: true, reason: 'unknown-project'
      });
    }
  });

  it('does not use display names, path basenames or fuzzy matches as aliases', () => {
    const project = { path: '/approved/secret', name: 'Display Name', aliases: ['approved label'] };
    for (const target of ['Display Name', 'secret', 'approved lable']) {
      expect(resolveVoiceProject(`fix login in ${target}`, [project], attached).reason).toBe('unknown-project');
    }
  });

  it.each([
    'fix login in D:\\approved\\atlas',
    'fix login on d:/approved/atlas',
    'Ｄ：＼approved＼atlas में fix login',
    'D:\\approved\\atlas mein fix login',
    'fix login in "D:\\My Projects\\atlas"',
    'fix login in /approved/atlas',
    'in /atlas, add tests',
    'in /, add tests',
    '/approved/atlas में लॉगिन बनाओ',
    'fix login in \\\\server\\share\\atlas',
    'fix login in //server/share/atlas',
    'fix login in ~/atlas',
    'in atlas, read D:\\secrets\\config.json',
    'read /etc/passwd',
    'in atlas,/etc/passwd',
    'in atlas, inspect \\rooted\\file',
    'in / then fix login'
  ])('rejects full paths anywhere, including registered paths: %s', (transcript) => {
    expect(resolveVoiceProject(transcript, registrations, attached)).toEqual({
      goal: transcript, needsSelection: true, reason: 'explicit-path'
    });
  });

  it('does not let a malformed path alias bypass rejection', () => {
    const projects = [{ ...atlas, aliases: ['D:\\approved\\atlas', '/approved/atlas', 'atlas'] }];
    expect(resolveVoiceProject('in D:\\approved\\atlas', projects, attached).reason).toBe('explicit-path');
    expect(resolveVoiceProject('in atlas, fix login', projects).project).toEqual(atlasProject);
  });
});

describe('ambiguity and overlapping aliases', () => {
  it('requires selection for an exact alias owned by two projects', () => {
    const projects = [atlas, { ...shop, aliases: ['ＡＴＬＡＳ'] }];
    for (const ordered of [projects, [...projects].reverse()]) {
      expect(resolveVoiceProject('in atlas, fix login', ordered, atlas)).toEqual({
        goal: 'in atlas, fix login', needsSelection: true, reason: 'ambiguous-project'
      });
    }
  });

  it.each(['in atlas and on shop, fix login', 'atlas mein fix login, दुकान में tests जोड़ो'])('asks on multiple project mentions: %s', (transcript) => {
    expect(resolveVoiceProject(transcript, registrations, attached)).toEqual({
      goal: transcript, needsSelection: true, reason: 'ambiguous-project'
    });
  });

  it('does not mistake a short prefix alias for a complete longer project name', () => {
    const projects = [atlas, { ...shop, aliases: ['atlas mobile'] }];
    for (const ordered of [projects, [...projects].reverse()]) {
      expect(resolveVoiceProject('in atlas mobile, fix login', ordered, attached)).toEqual({
        project: { path: shop.path, name: shop.name }, goal: 'fix login', needsSelection: false, reason: 'registered-alias'
      });
    }
  });

  it('asks instead of guessing when overlapping suffix aliases belong to different projects', () => {
    const projects = [atlas, { ...shop, aliases: ['my atlas'] }];
    for (const ordered of [projects, [...projects].reverse()]) {
      expect(resolveVoiceProject('my atlas mein fix login', ordered, attached).reason).toBe('ambiguous-project');
    }
  });

  it('permits overlapping and repeated aliases for the same registered path', () => {
    const projects = [{ ...atlas, aliases: ['atlas', 'my atlas', 'ATLAS'] }];
    expect(resolveVoiceProject('my atlas mein fix login', projects)).toEqual({
      project: atlasProject, goal: 'fix login', needsSelection: false, reason: 'registered-alias'
    });
    expect(resolveVoiceProject('in atlas, fix login on atlas', projects)).toEqual({
      project: atlasProject, goal: 'fix login', needsSelection: false, reason: 'registered-alias'
    });
    expect(resolveVoiceProject('in atlas mein fix login', projects).goal).toBe('fix login');
  });

  it('does not treat prepositions inside a registered alias as unknown slots', () => {
    const projects = [{ ...atlas, aliases: ['work in progress', 'on call', 'mein app'] }];
    for (const transcript of ['in work in progress, fix login', 'on call mein fix login', 'in mein app, fix login']) {
      expect(resolveVoiceProject(transcript, projects)).toEqual({
        project: atlasProject, goal: 'fix login', needsSelection: false, reason: 'registered-alias'
      });
    }
  });
});

describe('no project mention and pure integration API', () => {
  it.each([
    'Build an atlas viewer',
    'fix shop checkout',
    'Atlas login page banao',
    'दुकान का लॉगिन बनाओ',
    'make the atlas-dashboard faster',
    'implement inline docs',
    'Fix Login! Keep Case and हिन्दी vowel marks.'
  ])('leaves arbitrary goal tokens untouched: %s', (transcript) => {
    expect(resolveVoiceProject(transcript, registrations, attached)).toEqual({
      project: attached, goal: transcript, needsSelection: false, reason: 'attached-project'
    });
    expect(resolveVoiceProject(transcript, registrations)).toEqual({
      goal: transcript, needsSelection: true, reason: 'no-project'
    });
  });

  it('does not auto-select the only registration when nothing is attached', () => {
    expect(resolveVoiceProject('fix login', [atlas])).toEqual({
      goal: 'fix login', needsSelection: true, reason: 'no-project'
    });
    expect(resolveVoiceProject('in atlas, fix login', [atlas]).project).toEqual(atlasProject);
  });

  it('handles empty inputs and an empty registry synchronously', () => {
    expect(resolveVoiceProject('  ', [])).toEqual({ needsSelection: true, reason: 'no-project' });
    expect(resolveVoiceProject('', [], attached)).toEqual({ project: attached, needsSelection: false, reason: 'attached-project' });
    expect(resolveVoiceProject('in atlas, fix login', [], attached).reason).toBe('unknown-project');
  });

  it('does not mutate registrations or attachments or return their references', () => {
    const project = Object.freeze({ ...atlas, aliases: Object.freeze([...atlas.aliases]) });
    const registry = Object.freeze([project]);
    const attachment = Object.freeze({ ...attached });
    const result = resolveVoiceProject('in atlas, fix login', registry, attachment);
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.project).not.toBe(project);
    expect(resolveVoiceProject('fix login', registry, attachment).project).not.toBe(attachment);
    result.project!.name = 'Changed';
    expect(project.name).toBe('Atlas Dashboard');
    expect(resolveVoiceProject('in atlas, fix login', registry, attachment).project).toEqual(atlasProject);
  });
});
