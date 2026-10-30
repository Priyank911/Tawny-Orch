import { readFile } from 'node:fs/promises';

const tag = process.env.RELEASE_TAG ?? '';
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const expected = `v${packageJson.version}`;
if (tag !== expected) {
  console.error(`Release tag ${tag || '(missing)'} must match package.json version ${expected}. Bump package.json and pnpm-lock.yaml before tagging.`);
  process.exit(1);
}
console.log(`Release tag ${tag} matches package.json.`);
