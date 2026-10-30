import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const outputDirectory = resolve(process.argv[2] ?? 'release');
const candidates = (await readdir(outputDirectory)).filter((name) => name.toLowerCase().endsWith('.exe') &&
  !name.toLowerCase().includes('uninstall'));
if (candidates.length !== 1) {
  throw new Error(`Expected exactly one Windows setup .exe in ${outputDirectory}; found ${candidates.length}.`);
}

const fileName = candidates[0];
const filePath = join(outputDirectory, fileName);
const [contents, metadata, packageJson] = await Promise.all([
  readFile(filePath), stat(filePath), readFile(resolve('package.json'), 'utf8').then(JSON.parse)
]);
const sha512 = createHash('sha512').update(contents).digest('base64');
const manifest = [
  `version: ${JSON.stringify(packageJson.version)}`,
  'files:',
  `  - url: ${JSON.stringify(fileName)}`,
  `    sha512: ${sha512}`,
  `    size: ${metadata.size}`,
  `path: ${JSON.stringify(fileName)}`,
  `sha512: ${sha512}`,
  `releaseDate: ${new Date().toISOString()}`,
  ''
].join('\n');
await writeFile(join(outputDirectory, 'latest.yml'), manifest, 'utf8');
console.log(`Wrote Windows update manifest for ${fileName} (${metadata.size} bytes).`);
