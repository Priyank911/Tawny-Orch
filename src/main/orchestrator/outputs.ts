import { isAbsolute, normalize, sep } from 'node:path';

/**
 * Infer explicitly named files and conventional Markdown deliverables from
 * clear creation language. Never infer files from stage names alone (for
 * example, "plan the feature" does not create plan.md).
 */
export function inferRequestedOutputs(goal: string): string[] {
  const output = new Set<string>();
  const expression = /\b(?:create|write|make|generate|save|produce|add)\s+(?:(?:a|an|the)\s+)?[`"'(\[]?((?:[\w.-]+[\\/])*[\w.-]+\.[a-zA-Z0-9]{1,10})[`"')\]]?/gi;
  for (const match of goal.matchAll(expression)) {
    const safe = validateOutputPath(match[1]);
    if (safe) output.add(safe);
  }
  const explicitlyCreatesPlan = /\b(?:create|write|make|generate|save|produce|add)\s+(?:(?:a|an|the)\s+)?(?:detailed\s+|implementation\s+)?plan\b/i.test(goal);
  const explicitlyCreatesArchitecture = /\b(?:create|write|make|generate|save|produce|add)\s+(?:(?:a|an|the)\s+)?(?:system\s+)?architecture\b/i.test(goal);
  const planFilenameRequested = [...output].some((file) => /(?:^|\/)plan\.md$/i.test(file));
  const architectureFilenameRequested = [...output].some((file) => /(?:^|\/)architecture\.md$/i.test(file));
  if (explicitlyCreatesPlan && !planFilenameRequested) output.add('plan.md');
  if (explicitlyCreatesArchitecture && !architectureFilenameRequested) output.add('architecture.md');
  // Natural shorthand such as "make a plan + architecture" requests both
  // project documents. "Create plan.md with architecture" remains one file.
  if (explicitlyCreatesPlan && /\bplan\b\s*(?:\+|and|&)\s*(?:the\s+)?architecture\b/i.test(goal) &&
      !architectureFilenameRequested) output.add('architecture.md');
  return [...output];
}

/** Return a normalized project-relative path, or undefined when unsafe. */
export function validateOutputPath(input: string): string | undefined {
  const value = input.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!value || value.startsWith('/') || /^[a-zA-Z]:/.test(value) || value.includes('\0')) return undefined;
  const segments = value.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..' || /^(?:\.git|\.tawny-orch)$/i.test(part))) return undefined;
  const normalized = normalize(value).split(sep).join('/');
  if (!normalized || normalized === '.' || normalized.startsWith('../') || isAbsolute(normalized)) return undefined;
  return normalized;
}
