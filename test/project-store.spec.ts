import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectConfigSchema } from '../src/shared/contracts';

const electron = vi.hoisted(() => ({ userData: '', showOpenDialog: vi.fn() }));
const faults = vi.hoisted(() => ({ rename: false }));
vi.mock('electron', () => ({
  app: { getPath: () => electron.userData },
  dialog: { showOpenDialog: electron.showOpenDialog }
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: (...args: Parameters<typeof actual.rename>) => {
    if (faults.rename) return Promise.reject(new Error('simulated rename failure'));
    return actual.rename(...args);
  } };
});
import {
  chooseProjectFolder, listRegisteredProjects, projectStats, readAttachedProject,
  readProjectConfig, resolveRegisteredProject, saveAttachedProject, saveProjectConfig
} from '../src/main/projectStore';
import { atomicWriteFile } from '../src/main/storage';

let root: string;
let folder: string;
const attachedFile = () => join(electron.userData, 'orchestrator', 'attached-project.json');
const registryFile = () => join(electron.userData, 'orchestrator', 'projects.json');

async function pick(path = folder, alias?: string) {
  electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [path] });
  return chooseProjectFolder(alias);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tawny-project-'));
  electron.userData = join(root, '新用户', 'fresh');
  folder = join(root, '项目 café');
  await mkdir(folder, { recursive: true });
  faults.rename = false;
  electron.showOpenDialog.mockReset();
});
afterEach(async () => {
  faults.rename = false;
  await rm(root, { recursive: true, force: true });
});

describe('project persistence', () => {
  it('creates fresh Unicode config directories and validates round trips', async () => {
    const config = projectConfigSchema.parse({ templateId: 'duo' });
    await saveProjectConfig(folder, config);
    expect(await readProjectConfig(folder)).toMatchObject({ ...config, updatedAt: expect.any(String) });
    expect(JSON.parse(await readFile(join(folder, '.tawny-orch', 'config.json'), 'utf8')).version).toBe(1);
  });

  it('returns defaults for missing or malformed config without overwriting it', async () => {
    expect(await readProjectConfig(folder)).toEqual(projectConfigSchema.parse({}));
    await mkdir(join(folder, '.tawny-orch'));
    const file = join(folder, '.tawny-orch', 'config.json');
    await writeFile(file, '{broken');
    expect(await readProjectConfig(folder)).toEqual(projectConfigSchema.parse({}));
    expect(await readFile(file, 'utf8')).toBe('{broken');
  });

  it('preserves the old file and removes temporary files if atomic replacement fails', async () => {
    const file = join(folder, 'config.json');
    await atomicWriteFile(file, 'old');
    faults.rename = true;
    await expect(atomicWriteFile(file, 'new')).rejects.toThrow('simulated rename failure');
    expect(await readFile(file, 'utf8')).toBe('old');
    expect(await readdir(folder)).toEqual(['config.json']);
  });

  it('keeps concurrent writes complete', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, index) => saveProjectConfig(folder, projectConfigSchema.parse({ templateId: `template-${index}` }))));
    expect((await readProjectConfig(folder)).templateId).toMatch(/^template-\d+$/);
    expect(await readdir(join(folder, '.tawny-orch'))).toEqual(['config.json']);
  });

  it('requires existing directories for config writes and stats', async () => {
    const file = join(root, 'file');
    await writeFile(file, 'not a folder');
    await expect(saveProjectConfig(file, projectConfigSchema.parse({}))).rejects.toThrow('directory');
    expect(await projectStats(file)).toEqual({ exists: false, isGit: false });
    expect(await projectStats(join(root, 'missing'))).toEqual({ exists: false, isGit: false });
    await writeFile(join(folder, '.git'), 'gitdir: elsewhere');
    expect(await projectStats(folder)).toEqual({ exists: true, isGit: true });
  });

  it.each([null, {}, { path: 42 }, { path: '', name: 'bad', isGit: false },
    { path: '.', name: 'bad', isGit: false }, { path: 'x\0y', name: 'bad', isGit: false },
    { path: '/missing', name: 'bad', isGit: false }, { path: '/missing', name: 42, isGit: 'yes' }
  ])('ignores malformed or missing attachments: %j', async (value) => {
    await mkdir(join(electron.userData, 'orchestrator'), { recursive: true });
    await writeFile(attachedFile(), JSON.stringify(value));
    expect(await readAttachedProject()).toBeNull();
  });

  it('rejects attached files and refreshes Git metadata for valid folders', async () => {
    await pick();
    await mkdir(join(folder, '.git'));
    expect(await readAttachedProject()).toMatchObject({ path: await realpath(folder), isGit: true });
    await rm(folder, { recursive: true });
    await writeFile(folder, 'replaced by a file');
    expect(await readAttachedProject()).toBeNull();
  });

  it('creates the attachment directory when detaching a fresh install', async () => {
    await saveAttachedProject(null);
    expect(await readAttachedProject()).toBeNull();
    expect(await readFile(attachedFile(), 'utf8')).toBe('null');
  });
});

describe('picker-backed project registry', () => {
  it('registers picked folders, persists aliases, and resolves only complete aliases', async () => {
    const project = await pick(folder, 'Café App');
    expect(await readAttachedProject()).toEqual(project);
    expect(await resolveRegisteredProject(' café app ')).toEqual(project);
    expect(await resolveRegisteredProject('cafe\u0301 app')).toEqual(project);
    for (const input of [folder, '../项目 café', 'Café', 'open Café App', 'C:/arbitrary', '\\server\\share']) {
      expect(await resolveRegisteredProject(input)).toBeNull();
    }
    await pick(folder, 'backend');
    expect((await listRegisteredProjects())[0].aliases).toEqual(['Café App', 'backend']);
    expect(await resolveRegisteredProject('BACKEND')).toEqual(project);
    expect(JSON.parse(await readFile(registryFile(), 'utf8')).projects).toHaveLength(1);
  });

  it('refuses arbitrary paths even when they exist', async () => {
    await expect(saveAttachedProject({ path: folder, name: 'dictated', isGit: false })).rejects.toThrow('not registered');
    expect(await listRegisteredProjects()).toEqual([]);
    await expect(chooseProjectFolder('../unsafe')).rejects.toThrow();
    expect(electron.showOpenDialog).not.toHaveBeenCalled();
  });

  it('does not register cancelled or invalid selections', async () => {
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [folder] });
    expect(await chooseProjectFolder()).toBeNull();
    const file = join(root, 'plain-file');
    await writeFile(file, 'x');
    await expect(pick(file)).rejects.toThrow('directory');
    expect(await listRegisteredProjects()).toEqual([]);
  });

  it('disambiguates duplicate folder names without reassigning explicit aliases', async () => {
    const second = join(root, 'other', '项目 café');
    await mkdir(second, { recursive: true });
    await pick();
    await pick(second);
    expect((await listRegisteredProjects()).map((entry) => entry.aliases[0])).toEqual(['项目 café', '项目 café (2)']);
    await expect(pick(second, '项目 café')).rejects.toThrow('already registered');
    expect((await resolveRegisteredProject('项目 café'))?.path).toBe(await realpath(folder));
  });

  it('retains unavailable registrations without resolving them', async () => {
    await pick(folder, 'offline');
    await rm(folder, { recursive: true });
    expect(await resolveRegisteredProject('offline')).toBeNull();
    expect(await listRegisteredProjects()).toHaveLength(1);
  });

  it('does not silently overwrite corrupt registries', async () => {
    await pick();
    await writeFile(registryFile(), 'broken');
    await expect(pick()).rejects.toThrow('Cannot read project registry');
    expect(await readFile(registryFile(), 'utf8')).toBe('broken');
  });

  it('does not cap projects and serializes concurrent registrations', async () => {
    const folders = await Promise.all(Array.from({ length: 40 }, async (_, index) => {
      const path = join(root, `project-${index}`);
      await mkdir(path);
      return path;
    }));
    // Queue picker responses synchronously before each asynchronous registration.
    for (const path of folders) electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [path] });
    await Promise.all(folders.map(() => chooseProjectFolder()));
    expect(await listRegisteredProjects()).toHaveLength(40);
    expect(await resolveRegisteredProject('project-39')).not.toBeNull();
  });
});
