import { app, dialog } from 'electron';
import { readFile, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { ProjectAttachment, ProjectConfig } from '../shared/contracts';
import { projectAttachmentSchema, projectConfigSchema } from '../shared/contracts';
import { atomicWriteFile, isMissingFile, withStorageLock } from './storage';

const attachedFile = (): string => join(app.getPath('userData'), 'orchestrator', 'attached-project.json');
const registryFile = (): string => join(app.getPath('userData'), 'orchestrator', 'projects.json');
const projectConfigFile = (projectPath: string): string => join(projectPath, '.tawny-orch', 'config.json');
const validPath = z.string().min(1).refine((path) => isAbsolute(path) && !path.includes('\0'));
const attachmentSchema = projectAttachmentSchema.extend({ path: validPath, name: z.string().min(1) });
const aliasSchema = z.string().trim().min(1).refine((alias) => !/[\\/:\x00-\x1f]/.test(alias) && alias !== '.' && alias !== '..', 'Aliases cannot be paths');
const registeredProjectSchema = attachmentSchema.extend({ aliases: z.array(aliasSchema).min(1) });
const registrySchema = z.object({ version: z.literal(1), projects: z.array(registeredProjectSchema) });
export type RegisteredProject = z.infer<typeof registeredProjectSchema>;
const aliasKey = (alias: string): string => alias.normalize('NFC').trim().toLowerCase();
const pathKey = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path;

async function directoryPath(path: string): Promise<string> {
  validPath.parse(path);
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) throw new Error('Project path must be a directory');
  return canonical;
}

async function readRegistry(): Promise<RegisteredProject[]> {
  try {
    const parsed = registrySchema.parse(JSON.parse(await readFile(registryFile(), 'utf8')));
    const aliases = new Set<string>();
    for (const project of parsed.projects) {
      for (const alias of project.aliases) {
        const key = aliasKey(alias);
        if (aliases.has(key)) throw new Error('Duplicate project alias in registry');
        aliases.add(key);
      }
    }
    return parsed.projects;
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw new Error('Cannot read project registry; existing registrations have not been overwritten', { cause: error });
  }
}

/** Local registrations are retained even when a drive is temporarily offline. */
export async function listRegisteredProjects(): Promise<RegisteredProject[]> {
  return readRegistry();
}

/** Exact, case-insensitive alias lookup only: never resolve user input as a path. */
export async function resolveRegisteredProject(alias: string): Promise<ProjectAttachment | null> {
  const parsed = aliasSchema.safeParse(alias);
  if (!parsed.success) return null;
  const project = (await readRegistry()).find((entry) => entry.aliases.some((value) => aliasKey(value) === aliasKey(parsed.data)));
  if (!project) return null;
  try {
    const path = await directoryPath(project.path);
    // Do not follow a registered folder replaced with a symlink to a different target.
    if (pathKey(path) !== pathKey(project.path)) return null;
    return { path, name: project.name, isGit: existsSync(join(path, '.git')) };
  } catch {
    return null;
  }
}

export async function readAttachedProject(): Promise<ProjectAttachment | null> {
  try {
    const project = attachmentSchema.parse(JSON.parse(await readFile(attachedFile(), 'utf8')));
    const path = await directoryPath(project.path);
    if (pathKey(path) !== pathKey(project.path)) return null;
    return { path, name: project.name, isGit: existsSync(join(path, '.git')) };
  } catch {
    return null;
  }
}

/** Only folders previously approved through the native picker may be attached. */
export async function saveAttachedProject(project: ProjectAttachment | null): Promise<void> {
  if (project === null) {
    await atomicWriteFile(attachedFile(), 'null');
    return;
  }
  const parsed = attachmentSchema.parse(project);
  const path = await directoryPath(parsed.path);
  const registration = (await readRegistry()).find((entry) => pathKey(entry.path) === pathKey(path));
  if (!registration) throw new Error('Project is not registered; choose the folder with the project picker first');
  if (pathKey(path) !== pathKey(parsed.path)) throw new Error('Registered project path has changed');
  await atomicWriteFile(attachedFile(), JSON.stringify({ path, name: registration.name, isGit: existsSync(join(path, '.git')) }, null, 2));
}

/** Optional aliases are local labels, never filesystem paths. Re-picking adds aliases. */
export async function chooseProjectFolder(alias?: string): Promise<ProjectAttachment | null> {
  const requestedAlias = alias === undefined ? undefined : aliasSchema.parse(alias);
  const result = await dialog.showOpenDialog({
    title: 'Attach a project folder',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const path = await directoryPath(result.filePaths[0]);
  const project: ProjectAttachment = { path, name: basename(path) || path, isGit: existsSync(join(path, '.git')) };
  await withStorageLock(registryFile(), async () => {
    const projects = await readRegistry();
    let entry = projects.find((candidate) => pathKey(candidate.path) === pathKey(path));
    let label = requestedAlias ?? aliasSchema.parse(basename(path) || 'project');
    const owner = (value: string) => projects.find((candidate) => candidate.aliases.some((item) => aliasKey(item) === aliasKey(value)));
    if (requestedAlias && owner(label) && owner(label) !== entry) throw new Error('Project alias is already registered');
    if (!requestedAlias && entry) label = entry.aliases[0];
    for (let suffix = 2; owner(label) && owner(label) !== entry; suffix++) label = `${basename(path) || 'project'} (${suffix})`;
    if (entry) {
      if (!entry.aliases.some((value) => aliasKey(value) === aliasKey(label))) entry.aliases.push(label);
      entry.isGit = project.isGit;
    } else {
      entry = { ...project, aliases: [label] };
      projects.push(entry);
    }
    await atomicWriteFile(registryFile(), JSON.stringify({ version: 1, projects }, null, 2));
  });
  await saveAttachedProject(project);
  return project;
}

export async function readProjectConfig(projectPath: string): Promise<ProjectConfig> {
  try {
    return projectConfigSchema.parse(JSON.parse(await readFile(projectConfigFile(projectPath), 'utf8')));
  } catch {
    return projectConfigSchema.parse({});
  }
}

export async function saveProjectConfig(projectPath: string, config: ProjectConfig): Promise<void> {
  const path = await directoryPath(projectPath);
  const parsed = projectConfigSchema.parse({ ...config, updatedAt: new Date().toISOString() });
  await atomicWriteFile(projectConfigFile(path), JSON.stringify(parsed, null, 2));
}

export async function projectStats(path: string): Promise<{ exists: boolean; isGit: boolean }> {
  try {
    const directory = await directoryPath(path);
    return { exists: true, isGit: existsSync(join(directory, '.git')) };
  } catch {
    return { exists: false, isGit: false };
  }
}
