import type { VoiceDecision, VoiceIntent } from '../../shared/contracts';

// Voice grammar — Tawny's local dictation routing, re-aimed at orchestration.
// Default stance (Tawny rule 3 adapted): anything that survives the dictionaries
// is treated as the goal for the attached project — never dropped.

const WAKE_PHRASES = ['hey tawny', 'hey buddy', 'hey body', 'hey orchestr'];

export function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s:\\/.\-]/gu, ' ').replace(/ +/g, ' ').trim();
}

function levenshtein(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1]
        ? previous[j - 1]
        : Math.min(previous[j - 1] + 1, previous[j] + 1, current[j - 1] + 1);
    }
    previous = current;
  }
  return previous[right.length];
}

function pickWake(text: string): { routed: boolean; rest: string } {
  const tokens = text ? text.split(' ') : [];
  const maxStart = Math.min(2, Math.max(0, tokens.length - 2));
  for (let start = 0; start <= maxStart; start += 1) {
    for (const phrase of WAKE_PHRASES) {
      const phraseTokens = phrase.split(' ');
      const candidate = tokens.slice(start, start + phraseTokens.length).join(' ');
      if (candidate && levenshtein(candidate, phrase) <= 2) {
        return { routed: true, rest: tokens.slice(start + phraseTokens.length).join(' ').trim() };
      }
    }
  }
  return { routed: tokens.length === 0, rest: text };
}

const FOLDER_RE = /\b(?:in|on|into|open|attach|use|folder)\s+((?:[a-z]{1,2}:\\[^\s"][^"“”]*|\/[\w.*-]+\/[^"“”]*))\s*$/i;
const FOLDER_INLINE_RE = /\b(?:in|on|into)\s+((?:[a-z]{1,2}:\\[^"“”]+?|\/[\w.*-]+(?:\/[^"“”\s]+)*))(?=\s+(?:with|and|then|using)\b|\s*$)/i;

function extractFolder(text: string): { path: string; rest: string } | undefined {
  const inline = text.match(FOLDER_INLINE_RE) ?? text.match(FOLDER_RE);
  if (!inline) return undefined;
  const path = inline[1].trim().replace(/["“”]/g, '');
  if (path.length < 2) return undefined;
  return { path, rest: (text.slice(0, inline.index ?? 0) + ' ' + text.slice((inline.index ?? 0) + inline[0].length)).trim() };
}

const STOP_RE = /^(?:hey tawny[,.]?\s*)?(?:orch|orchestrator)?,?\s*(?:stop|cancel|abort|halt)(?:\s+(?:the\s+)?(?:run|pipeline|everything|task))?\b/;
const PAUSE_RE = /^(?:hey tawny[,.]?\s*)?(?:orch)?,?\s*pause(?:\s+(?:the\s+)?(?:run|pipeline))?/;
const RESUME_RE = /^(?:hey tawny[,.]?\s*)?(?:orch)?,?\s*(?:resume|continue)(?:\s+(?:the\s+)?(?:run|pipeline))?/;
const STATUS_RE = /^(?:hey tawny[,.]?\s*)?(?:orch)?,?\s*(?:what(?:'s| is)\s+(?:the\s+)?status(?:\s+(?:of\s+(?:the\s+)?(?:run|pipeline)))?|status(?:\s+(?:check|report|update))?|how(?:'s| is)\s+(?:the\s+)?(?:run|pipeline)\s+going|where\s+(?:are|is)\s+(?:we|the run))/;
const NEW_PROJECT_RE = /^(?:hey tawny[,.]?\s*)?(?:create|make|start|scaffold|new)\s+(?:a\s+)?(?:brand\s+[-\s])?new\s+project\s+(?:called\s+|named\s+)?(.+?)(?:\s+in\s+([a-z]{1,2}:\\[^"“”]+|\/[\w.*-]+(?:\/[^"“”\s]+)*))?\s*$/i;
const ASSIGN_RE = /^(?:hey tawny[,.]?\s*)?assign\s+(?:the\s+)?(research|planning|plan|execution|execute|testing|test|review|delivery|deliver)(?:\s+(?:stage|team|agent|work))?\s+(?:to\s+)?(?:(?:the\s+)?(claude(?:\s+code)?|codex|gemini(?:\s+cli)?|cursor(?:\s+agent)?|opencode|antigravity|muse(?:\s+code)?|qwen(?:\s+code)?|manual))\b/;
const BUILD_VERB_RE = /^(?:tawny[,.\s]*|hey tawny[,.\s]*)?(?:run|build|implement|create|make|add|fix|refactor|restructure|test|deploy|scaffold|write|ship)\b/;

const ROLE_ALIASES: Record<string, string> = {
  research: 'research', planning: 'plan', plan: 'plan',
  execution: 'execute', execute: 'execute',
  testing: 'test', test: 'test',
  review: 'review', delivery: 'deliver', deliver: 'deliver'
};

const AGENT_ALIASES: Record<string, string> = {
  'claude': 'claude-code', 'claude code': 'claude-code',
  'codex': 'codex', 'open ai': 'codex', 'openai': 'codex',
  'gemini': 'gemini-cli', 'gemini cli': 'gemini-cli',
  'cursor': 'cursor-agent', 'cursor agent': 'cursor-agent',
  'opencode': 'opencode', 'open code': 'opencode',
  'antigravity': 'antigravity', 'muse': 'muse-code', 'muse code': 'muse-code',
  'qwen': 'qwen-code', 'qwen code': 'qwen-code',
  'manual': 'manual', 'human': 'manual', 'myself': 'manual'
};

export interface VoiceGrammarInput {
  transcript: string;
  alwaysRoute: boolean;
  attachedProjectPath?: string;
}

export interface VoiceGateResult {
  routed: boolean;
  decision: VoiceDecision;
}

function decide(partial: { intent: VoiceIntent } & Partial<VoiceDecision>): VoiceDecision {
  return {
    goal: '',
    projectPath: '',
    projectName: '',
    decidedBy: 'local',
    confidence: 1,
    ...partial
  };
}

export function parseVoiceCommand(input: VoiceGrammarInput): VoiceGateResult {
  const normalized = normalize(input.transcript);
  if (!normalized) {
    return {
      routed: false,
      decision: decide({ intent: 'dictation_goal', confidence: 0, decidedBy: 'local-vacuum', message: 'Nothing was said.' })
    };
  }
  const wake = pickWake(normalized);
  const payload = wake.rest.length > 0 ? wake.rest : normalized;
  // Utility intents (status checks, folder attachment) route without the wake
  // phrase; destructive or run-starting intents need the wake or alwaysRoute.
  const routed = input.alwaysRoute || wake.routed || isUtilityIntent(payload);

  const direct = routed ? directIntent(payload, input.attachedProjectPath) : undefined;
  if (direct) {
    return { routed: true, decision: direct };
  }

  const folder = extractFolder(payload);
  const goalText = (folder ? folder.rest : payload).replace(/^(?:please|orch)\s+/, '').trim();

  if (routed && /^(?:hey tawny[,.]?\s*)?(?:what|status|how)/.test(payload) && /status|run|pipeline|going/i.test(payload)) {
    return { routed: true, decision: decide({ intent: 'status', decidedBy: 'local-status', confidence: 0.9 }) };
  }

  if (routed && folder && folder.rest.length < 3 && input.attachedProjectPath) {
    // "attach folder D:\x" with no explicit goal
    return {
      routed: true,
      decision: decide({
        intent: 'attach_folder',
        projectPath: folder.path,
        decidedBy: 'local-folder',
        confidence: 0.95,
        message: `Folder attached: ${folder.path}`
      })
    };
  }

  return {
    routed,
    decision: decide({
      intent: 'dictation_goal',
      goal: goalText,
      projectPath: folder?.path ?? input.attachedProjectPath ?? '',
      decidedBy: routed ? 'local-dictation' : 'local-dictation-unrouted',
      confidence: routed ? 0.75 : 0.35,
      message: routed ? undefined : 'Wake phrase not detected; nothing routed.'
    })
  };
}

function directIntent(payload: string, attachedProjectPath?: string): VoiceDecision | undefined {
  if (STOP_RE.test(payload)) {
    return decide({ intent: 'stop_run', decidedBy: 'local-stop', message: 'Stopping the active run.' });
  }
  if (PAUSE_RE.test(payload)) {
    return decide({ intent: 'pause_run', decidedBy: 'local-pause', message: 'Pausing after the current stage.' });
  }
  if (RESUME_RE.test(payload)) {
    return decide({ intent: 'resume_run', decidedBy: 'local-resume', message: 'Resuming.' });
  }
  const status = STATUS_RE.exec(payload);
  if (status) {
    return decide({ intent: 'status', decidedBy: 'local-status', confidence: 0.95 });
  }
  const newProject = NEW_PROJECT_RE.exec(payload);
  if (newProject) {
    const name = newProject[1].trim();
    const path = newProject[2]?.trim() ?? attachedProjectPath ?? '';
    return decide({
      intent: 'new_project',
      projectPath: path,
      projectName: titleCase(name),
      goal: `Scaffold a production-grade new project named ${titleCase(name)}${path ? ` in ${path}` : ''} and finish it to a working state.`,
      decidedBy: 'local-new-project',
      confidence: 0.9
    });
  }
  const assign = ASSIGN_RE.exec(payload);
  if (assign) {
    const role = ROLE_ALIASES[assign[1].toLowerCase()] ?? undefined;
    const agent = AGENT_ALIASES[assign[2].toLowerCase()] ?? undefined;
    return decide({
      intent: 'assign_role',
      role: (role as VoiceDecision['role']),
      agentId: agent,
      decidedBy: 'local-assign',
      confidence: 0.9,
      message: `Assign ${assign[1]} → ${assign[2]}${agent ? ` (${agent})` : ''}`
    });
  }
  const attachFolder = payload.match(/^(?:hey tawny[,.\s]*)?(?:open|attach|use)\s+(?:the\s+)?folder\s+((?:[a-z]{1,2}:\\[^\s"]+|\/[\w.*-]+(?:\/\S+)*))\s*$/i);
  if (attachFolder) {
    return decide({
      intent: 'attach_folder',
      projectPath: attachFolder[1].trim(),
      decidedBy: 'local-attach',
      confidence: 0.95,
      message: `Folder attached: ${attachFolder[1].trim()}`
    });
  }
  const buildVerb = BUILD_VERB_RE.exec(payload);
  if (buildVerb) {
    const folder = extractFolder(payload);
    return decide({
      intent: 'build_in_project',
      goal: (folder ? folder.rest : payload).replace(/^tawny,?\s*/, '').trim(),
      projectPath: folder?.path ?? attachedProjectPath ?? '',
      projectName: folder?.path ? folder.path.split(/[\\/]/).filter(Boolean).pop() ?? '' : '',
      decidedBy: 'local-build',
      confidence: 0.85
    });
  }
  return undefined;
}

function isUtilityIntent(payload: string): boolean {
  const attach = /^(?:hey tawny[,.\s]*)?(?:open|attach|use)\s+(?:the\s+)?folder\s+/i.test(payload);
  return attach || STATUS_RE.test(payload);
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    .slice(0, 60);
}

export const VOICE_INTENT_LABELS: Record<VoiceIntent, string> = {
  build_in_project: 'Build in project',
  new_project: 'New project',
  attach_folder: 'Attach folder',
  status: 'Status',
  stop_run: 'Stop run',
  pause_run: 'Pause run',
  resume_run: 'Resume run',
  assign_role: 'Assign role',
  dictation_goal: 'Run as goal'
};
