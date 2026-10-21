export interface VoiceProject {
  path: string;
  name: string;
  isGit?: boolean;
}

export interface VoiceProjectRegistration extends VoiceProject {
  aliases: readonly string[];
}

export interface VoiceProjectResolution {
  project?: VoiceProject;
  goal?: string;
  needsSelection: boolean;
  reason: 'registered-alias' | 'attached-project' | 'no-project' | 'unknown-project' | 'ambiguous-project' | 'explicit-path';
}

interface Span { start: number; end: number }
interface Mention extends Span { project: VoiceProjectRegistration }

const WORD_START = /^[\p{L}\p{M}\p{N}_-]/u;
const WORD_END = /[\p{L}\p{M}\p{N}_-]$/u;
const key = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

// Match against NFKC, but retain source offsets so the goal keeps its original
// casing, Hindi vowel marks, punctuation and compatibility characters.
function normalizedSource(source: string): { text: string; spans: Span[] } {
  let text = '';
  const spans: Span[] = [];
  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(source);
  for (const { segment, index } of segments) {
    const normalized = segment.normalize('NFKC').toLowerCase();
    for (const character of normalized) {
      if (/\s/u.test(character)) {
        if (text.endsWith(' ')) {
          spans[spans.length - 1].end = index + segment.length;
          continue;
        }
        text += ' ';
        spans.push({ start: index, end: index + segment.length });
      } else {
        text += character;
        for (let unit = 0; unit < character.length; unit++) {
          spans.push({ start: index, end: index + segment.length });
        }
      }
    }
  }
  // Whole-string lowercasing also handles contextual forms such as Greek sigma.
  return { text: source.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' '), spans };
}

function hasFullPath(text: string): boolean {
  return /[a-z]:[\\/]/iu.test(text)
    || /(?<![\p{L}\p{M}\p{N}_:\/\\])(?:[\\/]|~[\\/])/u.test(text);
}

function attachment(project: VoiceProject): VoiceProject {
  return {
    path: project.path,
    name: project.name,
    ...(project.isGit === undefined ? {} : { isGit: project.isGit })
  };
}

// A prefix target must finish at a clause boundary, not just at the first
// familiar word in an unknown multi-word name ("in Atlas Mobile", for example).
function endsPrefixTarget(rest: string): boolean {
  return !rest || /^[\s]*[,;:.!?"'”’)]/u.test(rest)
    || /^\s+(?:build|fix|add|create|implement|make|run|test|refactor|write|deploy|scaffold|ship|please|with|using|and|then|in|on|mein|में|बनाओ|बनाना|करो|करना|जोड़ो)(?![\p{L}\p{M}\p{N}_-])/u.test(rest)
    || !rest.trim();
}

function extractGoal(source: string, normalizedSpans: Span[], mentions: Mention[]): string | undefined {
  const spans = mentions.map(({ start, end }) => ({
    start: normalizedSpans[start].start,
    end: normalizedSpans[end - 1].end
  })).sort((a, b) => a.start - b.start);
  let goal = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) goal += source.slice(cursor, span.start) + ' ';
    cursor = Math.max(cursor, span.end);
    // A comma/colon introducing the remaining goal belongs to the slot.
    const delimiter = source.slice(cursor).match(/^\s*[,;:]\s*/u);
    if (delimiter) cursor += delimiter[0].length;
  }
  goal += source.slice(cursor);
  return goal.replace(/\s+/gu, ' ').replace(/^[\s,;:.!?]+|[\s,;:]+$/gu, '').trim() || undefined;
}

/**
 * Pure routing hint for the main-process integration; no filesystem approval,
 * store access, wake-word handling or intent parsing happens here. Pass the raw
 * transcript (voice.normalize removes Hindi marks), trusted registry snapshots
 * and an optional already-approved attachment. Only aliases, not display names
 * or path basenames, are identifiers. Callers must still validate availability
 * through their project-store approval boundary before dispatching.
 *
 * Supported slots: `in <alias>`, `on <alias>`, `<alias> mein`, `<alias> में`.
 * Unknown explicit slots fail closed, including ordinary ambiguous uses of
 * these prepositions. Overlapping matches owned by different projects also
 * require selection; registry order and the attached project never break ties.
 */
export function resolveVoiceProject(
  transcript: string,
  registrations: readonly VoiceProjectRegistration[],
  attached?: VoiceProject | null
): VoiceProjectResolution {
  const { text, spans } = normalizedSource(transcript);
  const goal = transcript.trim() || undefined;
  const selection = (reason: VoiceProjectResolution['reason']): VoiceProjectResolution => ({
    ...(goal === undefined ? {} : { goal }), needsSelection: true, reason
  });
  if (hasFullPath(text)) return selection('explicit-path');

  const aliases = registrations.flatMap((project) => project.aliases.map((alias) => ({ project, alias: key(alias) })))
    .filter(({ alias }) => alias && !/[\\/:\x00-\x1f]/u.test(alias) && alias !== '.' && alias !== '..');
  const markers: (Span & { prefix: boolean })[] = [];
  const markerPattern = /(?<![\p{L}\p{M}\p{N}_-])(?:in|on|mein|में)(?![\p{L}\p{M}\p{N}_-])/gu;
  for (const match of text.matchAll(markerPattern)) {
    markers.push({ start: match.index, end: match.index + match[0].length, prefix: match[0] === 'in' || match[0] === 'on' });
  }

  const mentions: Mention[] = [];
  const unresolved: Span[] = [];
  for (const marker of markers) {
    let matched = false;
    for (const { project, alias } of aliases) {
      const gap = marker.prefix ? text.slice(marker.end).match(/^ +/u)?.[0].length
        : text.slice(0, marker.start).match(/ +$/u)?.[0].length;
      if (!gap) continue;
      const start = marker.prefix ? marker.end + gap : marker.start - gap - alias.length;
      const end = start + alias.length;
      if (start < 0 || text.slice(start, end) !== alias) continue;
      if (WORD_END.test(text.slice(0, start)) || WORD_START.test(text.slice(end))) continue;
      if (marker.prefix && !endsPrefixTarget(text.slice(end))) continue;
      mentions.push({ start: Math.min(marker.start, start), end: Math.max(marker.end, end), project });
      matched = true;
    }
    if (!matched) unresolved.push(marker);
  }
  // A marker inside a registered alias is label text, not another project slot.
  if (unresolved.some((marker) => !mentions.some((mention) => mention.start <= marker.start && mention.end >= marker.end))) {
    return selection('unknown-project');
  }
  const projects = new Map(mentions.map(({ project }) => [project.path, project]));
  if (projects.size > 1) return selection('ambiguous-project');
  const project = projects.values().next().value;
  if (project) {
    const extracted = extractGoal(transcript, spans, mentions);
    return { project: attachment(project), ...(extracted === undefined ? {} : { goal: extracted }), needsSelection: false, reason: 'registered-alias' };
  }
  if (attached) {
    return { project: attachment(attached), ...(goal === undefined ? {} : { goal }), needsSelection: false, reason: 'attached-project' };
  }
  return selection('no-project');
}
