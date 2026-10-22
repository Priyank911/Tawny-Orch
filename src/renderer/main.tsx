import { StrictMode, createContext, useCallback, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowRight, Ban, Bot, Check, ChevronDown, ChevronRight, ExternalLink, FolderOpen,
  Home as HomeIcon, Mic, RefreshCw, ScrollText, Settings2, ShieldCheck, Square, Terminal, Workflow, X
} from 'lucide-react';
import type {
  AgentStatus, AppSettings, OrchEvent, OverlaySnapshot, PipelineLog,
  PipelineTemplate, ProjectAttachment, ProjectConfig, RunSnapshot, StageSpec, StageStatus
} from '../shared/contracts';
import './styles.css';

const HOTKEY_LABEL = 'Ctrl + Alt + Space';
const MAX_CAPTURE_MS = 120_000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
type Page = 'home' | 'pipeline' | 'runs' | 'settings';
type Mode = 'shell' | 'pill';
const NAV = [
  { id: 'home' as Page, label: 'Cockpit', icon: HomeIcon },
  { id: 'pipeline' as Page, label: 'Pipeline', icon: Workflow },
  { id: 'runs' as Page, label: 'Runs & evidence', icon: ScrollText },
  { id: 'settings' as Page, label: 'Settings', icon: Settings2 }
];
const STATUS_CHIP: Record<StageStatus, { label: string; cls: string }> = {
  queued: { label: 'Queued', cls: 'slate' }, routed: { label: 'Routed', cls: 'blue' },
  contract_ready: { label: 'Ready', cls: 'blue' }, running: { label: 'Running', cls: 'blue' },
  gated: { label: 'Checking', cls: 'amber' }, passed: { label: 'Passed', cls: 'green' },
  failed: { label: 'Failed', cls: 'red' }, retrying: { label: 'Retrying', cls: 'amber' },
  escalated: { label: 'Needs you', cls: 'amber' }, skipped: { label: 'Skipped', cls: 'slate' },
  cancelled: { label: 'Cancelled', cls: 'slate' }
};
const RUN_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Pending', cls: 'slate' }, running: { label: 'Running', cls: 'blue' },
  escalated: { label: 'Needs you', cls: 'amber' }, done: { label: 'Finished', cls: 'green' },
  failed: { label: 'Failed', cls: 'red' }, cancelled: { label: 'Cancelled', cls: 'slate' }
};
type Failure = { title: string; detail: string };
const Feedback = createContext<{ failure: Failure | null; clear: () => void; report: (title: string, error: unknown) => void }>({
  failure: null, clear: () => undefined, report: () => undefined
});

function FeedbackProvider({ children }: { children: ReactNode }): ReactElement {
  const [failure, setFailure] = useState<Failure | null>(null);
  const report = useCallback((title: string, error: unknown) => {
    setFailure({ title, detail: error instanceof Error ? error.message : String(error) });
  }, []);
  return <Feedback.Provider value={{ failure, clear: () => setFailure(null), report }}>{children}</Feedback.Provider>;
}

// Event handlers always resolve; a failed bridge operation stays visible in the UI.
function useOperation(): [string | null, (label: string, work: () => Promise<void>) => Promise<void>] {
  const { report, clear } = useContext(Feedback);
  const [pending, setPending] = useState<string | null>(null);
  const locked = useRef(false);
  async function perform(label: string, work: () => Promise<void>): Promise<void> {
    if (locked.current) return;
    locked.current = true;
    clear();
    setPending(label);
    try { await work(); }
    catch (error) { report(`${label} failed. Check the details and try again.`, error); }
    finally { locked.current = false; setPending(null); }
  }
  return [pending, perform];
}

function ErrorNotice(): ReactElement | null {
  const { failure, clear } = useContext(Feedback);
  if (!failure) return null;
  return <div className="error-notice" role="alert">
    <div><strong>{failure.title}</strong><p>{failure.detail}</p></div>
    <button className="icon-btn" aria-label="Dismiss error" onClick={clear}><X size={17} /></button>
  </div>;
}

function effectiveConfig(stored: ProjectConfig, templates: PipelineTemplate[]): ProjectConfig {
  if (stored.stages.length) return stored;
  const template = templates.find((item) => item.id === stored.templateId);
  return { ...stored, stages: template?.stages.map((stage) => ({ ...stage })) ?? [] };
}

function ProviderNotice(): ReactElement {
  return <div className="provider-notice"><ShieldCheck size={18} aria-hidden="true" /><div>
    <strong>Your CLI, your configured model</strong>
    <p>Tawny launches the selected installed agent with its existing sign-in and model settings. Provider usage and charges follow that agent's account.</p>
  </div></div>;
}

function App(): ReactElement {
  const { report } = useContext(Feedback);
  const [mode, setMode] = useState<Mode>('shell');
  const [page, setPage] = useState<Page>('home');
  const [snapshot, setSnapshot] = useState<OverlaySnapshot>({ state: 'idle', elapsedMs: 0, rms: 0 });
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [project, setProject] = useState<ProjectAttachment | null>(null);
  const [templates, setTemplates] = useState<PipelineTemplate[]>([]);
  const [runs, setRuns] = useState<RunSnapshot[]>([]);
  const [events, setEvents] = useState<OrchEvent[]>([]);
  const [logs, setLogs] = useState<PipelineLog[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [openRunId, setOpenRunId] = useState<string>();
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  const [quickGoal, setQuickGoal] = useState('');
  const [pending, perform] = useOperation();
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const captureActive = useRef(false);
  const captureGeneration = useRef(0);
  const submitAudio = useRef(false);
    const captureTimeoutRef = useRef<number | undefined>(undefined);
    const captureBytesRef = useRef(0);
    const clearCaptureTimeout = useCallback(() => {
      window.clearTimeout(captureTimeoutRef.current);
      captureTimeoutRef.current = undefined;
    }, []);

  useEffect(() => {
    if (!window.tawnyOrch) {
      report('The desktop bridge is unavailable.', 'Open Tawny Orch in Electron, not a regular browser.');
      return;
    }
    let active = true;
    const api = window.tawnyOrch;
    async function load<T,>(label: string, request: () => Promise<T>, apply: (value: T) => void): Promise<void> {
      try { const value = await request(); if (active) apply(value); }
      catch (error) { if (active) report(`Could not load ${label}. Reopen the app to retry.`, error); }
    }
    void Promise.all([
      load('voice status', api.getSnapshot, setSnapshot), load('settings', api.getSettings, setSettings),
      load('terminals', api.getAgents, setAgents), load('project', api.getProject, setProject),
      load('templates', api.getTemplates, setTemplates), load('runs', api.getRuns, setRuns),
      load('events', api.getEvents, (list) => setEvents(list.slice(-200))), load('logs', api.getLogs, setLogs)
    ]).then(() => { if (active) setLoaded(true); });
    const off = [
      api.subscribe(setSnapshot), api.onMode(setMode), api.onProjectUpdate(setProject),
      api.onRunUpdate((run) => setRuns((list) => [run, ...list.filter((item) => item.id !== run.id)]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30))),
      api.onRunCreated((run) => {
        setRuns((list) => [run, ...list.filter((item) => item.id !== run.id)].slice(0, 30));
        setOpenRunId(run.id); setPage('runs');
      }),
      api.onVoiceAssign((decision) => setConfig((current) => current ? {
        ...current, stages: current.stages.map((stage) => stage.role === decision.role
          ? { ...stage, agentId: decision.agentId ?? null } : stage)
      } : current)),
      api.onEvent((event) => setEvents((list) => [...list.slice(-199), event])),
      api.onLog((entry) => setLogs((list) => [...list.slice(-199), entry]))
    ];
    const timer = window.setInterval(() => {
      void load('terminals', api.getAgents, setAgents);
      void load('runs', api.getRuns, setRuns);
    }, 20_000);
    return () => { active = false; off.forEach((unsubscribe) => unsubscribe()); window.clearInterval(timer); };
  }, [report]);

  useEffect(() => {
    let active = true;
    setConfig(null);
    if (!project) return;
    void window.tawnyOrch.getProjectConfig(project.path).then((stored) => {
      if (active) setConfig(effectiveConfig(stored, templates));
    }).catch((error: unknown) => { if (active) report('Could not load the project pipeline. Reattach the folder to retry.', error); });
    return () => { active = false; };
  }, [project?.path, templates, report]);

  const releaseMic = useCallback(() => {
    clearCaptureTimeout();
    captureBytesRef.current = 0;
    captureGeneration.current += 1;
    captureActive.current = false;
    submitAudio.current = false;
    const recorder = recorderRef.current;
    recorderRef.current = undefined;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
    chunksRef.current = [];
  }, [clearCaptureTimeout]);
  useEffect(() => releaseMic, [releaseMic]);

  useEffect(() => {
    async function startMic(): Promise<void> {
      captureActive.current = true;
      const generation = ++captureGeneration.current;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (generation !== captureGeneration.current) { stream.getTracks().forEach((track) => track.stop()); return; }
        streamRef.current = stream;
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
        const recorder = new MediaRecorder(stream, { mimeType });
        recorderRef.current = recorder;
        chunksRef.current = [];
        captureBytesRef.current = 0;
        recorder.ondataavailable = (event) => {
          if (!event.data.size || generation !== captureGeneration.current) return;
          captureBytesRef.current += event.data.size;
          if (captureBytesRef.current > MAX_UPLOAD_BYTES) {
            releaseMic();
            report('Voice capture exceeded the 25 MB upload limit.', 'No audio was uploaded. Record a shorter goal or type it instead.');
            window.tawnyOrch.send('CANCEL');
            return;
          }
          chunksRef.current.push(event.data);
        };
        recorder.onerror = () => {
          report('Voice capture stopped. Check microphone access and try again.', 'The audio recorder reported an error.');
          releaseMic(); window.tawnyOrch.send('CANCEL');
        };
        recorder.onstop = () => {
          if (generation !== captureGeneration.current) return;
          clearCaptureTimeout();
          // The stop event follows the final dataavailable event; never transcribe an incomplete buffer.
          const blobs = chunksRef.current;
          chunksRef.current = [];
          stream.getTracks().forEach((track) => track.stop());
          streamRef.current = undefined;
          recorderRef.current = undefined;
          if (!submitAudio.current) return;
          submitAudio.current = false;
          void (async () => {
            try {
              if (!blobs.length) throw new Error('No audio was captured. Check your microphone and record again.');
              if (blobs.reduce((total, blob) => total + blob.size, 0) > MAX_UPLOAD_BYTES) {
                throw new Error('Audio exceeds the 25 MB upload limit. Record a shorter goal or type it instead.');
              }
              const buffers = await Promise.all(blobs.map(async (blob) => new Uint8Array(await blob.arrayBuffer())));
              if (generation !== captureGeneration.current) return;
              await window.tawnyOrch.transcribeAudio(buffers);
            } catch (error) {
              if (generation === captureGeneration.current) {
                report('Could not transcribe this capture. Review the details and record again.', error);
                window.tawnyOrch.send('CANCEL');
              }
            }
          })();
        };
        recorder.start(1_000);
        captureTimeoutRef.current = window.setTimeout(() => {
          if (generation !== captureGeneration.current || recorder.state !== 'recording') return;
          captureTimeoutRef.current = undefined;
          captureActive.current = false;
          submitAudio.current = true;
          recorder.stop();
          window.tawnyOrch.send('STOP');
        }, MAX_CAPTURE_MS);
      } catch (error) {
        if (generation !== captureGeneration.current) return;
        releaseMic();
        report('Could not start voice capture. Allow microphone access in Windows Settings and retry.', error);
        window.tawnyOrch.send('CANCEL');
      }
    }
    if (snapshot.state === 'recording' && !captureActive.current) void startMic();
    else if (snapshot.state !== 'recording' && captureActive.current) {
      if (['cancelled', 'idle', 'failed'].includes(snapshot.state)) releaseMic();
      else {
        clearCaptureTimeout();
        captureActive.current = false;
        submitAudio.current = true;
        const recorder = recorderRef.current;
        if (recorder && recorder.state !== 'inactive') recorder.stop();
        else releaseMic();
      }
    } else if (['cancelled', 'idle', 'failed'].includes(snapshot.state)) {
      // Also invalidate transcription preparation if capture has already stopped.
      releaseMic();
    }
  }, [snapshot.state, releaseMic, clearCaptureTimeout, report]);

  const hotkey = settings?.prefs.hotkey || HOTKEY_LABEL;
  if (mode === 'pill') return <VoicePill snapshot={snapshot} hotkey={hotkey} />;
  const latestRun = runs.find((run) => run.projectPath === project?.path);
  function navigate(next: Page): void {
    setPage(next);
    if (next === 'runs') void perform('Refresh runs', async () => setRuns(await window.tawnyOrch.getRuns()));
  }
  return <div className="app-shell">
    <header className="titlebar">
      <div className="brand-badge"><img src="./tawny-orch-mark.svg" alt="" /></div>
      <span className="brand-name">Tawny <span>Orch</span></span>
      <span className="titlebar-caption">PROJECT COCKPIT</span>
      <div className="window-spacer" />
      <span className="local-label"><span className="dot green" /> Local-first workspace</span>
      <button className="window-btn" aria-label="Hide to system tray" onClick={() => window.tawnyOrch.hideWindow()}><X size={17} /></button>
    </header>
    <nav className="nav-tabs" aria-label="Workspace navigation">
      {NAV.map((tab) => <button key={tab.id} className={`nav-tab${page === tab.id ? ' active' : ''}`}
        aria-current={page === tab.id ? 'page' : undefined} aria-controls="workspace-page" onClick={() => navigate(tab.id)}>
        <tab.icon size={16} aria-hidden="true" />{tab.label}
      </button>)}
      <span className="nav-note">Your folder. Your tools. Your call.</span>
    </nav>
    <main id="workspace-page" className="page-scroll" aria-label={NAV.find((tab) => tab.id === page)?.label}>
      <div className="page-inner">
        <ErrorNotice />
        {!loaded ? <div className="loading-state" role="status">Loading your local workspace…</div> : null}
        {page === 'home' ? <HomePage snapshot={snapshot} project={project} agents={agents} config={config} templates={templates}
          setProject={setProject} setAgents={setAgents} quickGoal={quickGoal} setQuickGoal={setQuickGoal} loaded={loaded}
          latestRun={latestRun} hotkey={hotkey} onPipeline={() => navigate('pipeline')}
          onRun={(id) => { setOpenRunId(id); navigate('runs'); }} /> : null}
        {page === 'pipeline' ? <PipelineEditor project={project} templates={templates} config={config} setConfig={setConfig} agents={agents} /> : null}
        {page === 'runs' ? <RunsPage runs={runs} events={events} logs={logs} openRunId={openRunId} setOpenRunId={setOpenRunId}
          agents={agents} loaded={loaded} onStart={() => navigate('home')} refreshing={pending !== null} /> : null}
        {page === 'settings' ? <SettingsPage settings={settings} setSettings={setSettings} logs={logs} /> : null}
        <footer className="workspace-footer"><span>Tawny Orch · Built around your project folder</span><span>Provider access, limits and charges are separate.</span></footer>
      </div>
    </main>
  </div>;
}

function PageHeading({ eyebrow, title, children, action }: { eyebrow: string; title: string; children: ReactNode; action?: ReactNode }): ReactElement {
  return <div className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{children}</p></div>{action}</div>;
}

function HandoffRail({ stages, run }: { stages: StageSpec[]; run?: RunSnapshot }): ReactElement {
  const items = run ? run.stages.map((stage) => ({ spec: stage.spec, status: stage.status, agentId: stage.agentId }))
    : stages.map((spec) => ({ spec, status: undefined, agentId: spec.agentId }));
  return <ol className="handoff-rail" aria-label={run ? 'Recorded run handoffs' : 'Configured stage order'}>
    {items.map((item, index) => <li key={item.spec.id} className={`handoff-node ${item.status ?? 'configured'}`}>
      <span className="rail-marker" aria-hidden="true">{item.status === 'passed' ? <Check size={15} /> : String(index + 1).padStart(2, '0')}</span>
      <strong>{item.spec.title || item.spec.role}</strong><span className="rail-agent">{item.agentId ?? 'Router selects'}</span>
      <span className={`rail-state ${item.status ? STATUS_CHIP[item.status].cls : ''}`}>{item.status ? STATUS_CHIP[item.status].label : 'Configured'}</span>
    </li>)}
  </ol>;
}

type Review = { goal: string; project: ProjectAttachment; config: ProjectConfig };
function HomePage(props: {
  snapshot: OverlaySnapshot; project: ProjectAttachment | null; agents: AgentStatus[]; config: ProjectConfig | null;
  templates: PipelineTemplate[]; setProject: (project: ProjectAttachment | null) => void; setAgents: (agents: AgentStatus[]) => void;
  quickGoal: string; setQuickGoal: (goal: string) => void; loaded: boolean; latestRun?: RunSnapshot; hotkey: string;
  onPipeline: () => void; onRun: (id: string) => void;
}): ReactElement {
  const { snapshot, project, agents, config, templates, setProject, setAgents, quickGoal, setQuickGoal, loaded, latestRun, hotkey, onPipeline, onRun } = props;
  const [pending, perform] = useOperation();
  const [review, setReview] = useState<Review | null>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const installed = agents.filter((agent) => agent.detected).length;
  const state = snapshot.state;
  function attach(): void { void perform('Attach folder', async () => { const next = await window.tawnyOrch.attachProject(); if (next) setProject(next); }); }
  function prepareReview(): void {
    if (!project || quickGoal.trim().length < 4) return;
    void perform('Prepare review', async () => {
      const stored = effectiveConfig(await window.tawnyOrch.getProjectConfig(project.path), templates);
      if (!stored.stages.length) throw new Error('No stages are configured. Choose and save a pipeline first.');
      setReview({ goal: quickGoal.trim(), project: { ...project }, config: stored });
    });
  }
  function closeReview(): void {
    setReview(null);
    // The opener is inert until the modal has unmounted and closed.
    window.requestAnimationFrame(() => reviewButton.current?.focus());
  }
  function confirm(): void {
    if (!review) return;
    void perform('Dispatch run', async () => {
      const attached = await window.tawnyOrch.getProject();
      if (attached?.path !== review.project.path) throw new Error('The attached folder changed. Close this review and review the new project before dispatch.');
      const run = await window.tawnyOrch.createRun({ goal: review.goal, projectPath: review.project.path,
        templateId: review.config.templateId, overwriteStages: review.config.stages });
      if (!run) throw new Error('No run was created. Reattach your project folder and try again.');
      setQuickGoal(''); setReview(null); onRun(run.id);
    });
  }
  return <>
    <PageHeading eyebrow="YOUR LOCAL WORKSPACE" title={project ? project.name : 'Good work starts here.'}
      action={<button className="btn" onClick={attach} disabled={!loaded || pending !== null}><FolderOpen size={15} />{project ? 'Change folder' : 'Attach project'}</button>}>
      {project ? <span className="project-path">{project.path}</span> : 'Attach a project. Shape the handoffs. Review before you run.'}
    </PageHeading>
    <ProviderNotice />
    <section className="card rail-panel" aria-labelledby="handoff-title">
      <div className="section-top"><div><span className="eyebrow">THE HANDOFF RAIL</span><h2 id="handoff-title">One goal. A visible path to delivery.</h2></div>
        <button className="btn small" onClick={onPipeline}>Edit pipeline <ArrowRight size={14} /></button></div>
      <p className="card-sub">{latestRun ? 'Latest run in this folder · recorded stage states, not a completion forecast.' : 'Each stage hands its work to the next. Checks and recorded evidence live with the run.'}</p>
      {latestRun || config?.stages.length ? <HandoffRail stages={config?.stages ?? []} run={latestRun} />
        : <div className="rail-empty"><Workflow size={25} /><div><strong>{project ? 'Waiting for a configured pipeline' : 'Your pipeline belongs to your project'}</strong>
          <p>{project ? 'Choose a template in Pipeline, then save it to this folder.' : 'Attach a folder to see its stage order. Run history stays tied to that project.'}</p></div></div>}
      <div className="rail-footer"><span><ShieldCheck size={14} /> Outcomes need evidence, not just an agent summary.</span>
        {latestRun ? <button className="text-btn" onClick={() => onRun(latestRun.id)}>Inspect latest run <ArrowRight size={14} /></button>
          : <span className="utility">{project?.isGit ? 'Git project attached' : project ? 'Folder attached · no Git detected' : 'No folder attached'}</span>}</div>
    </section>
    <div className="cockpit-grid">
      <section className="card goal-panel" aria-labelledby="goal-title">
        <span className="eyebrow">NEXT PIECE OF WORK</span><h2 id="goal-title">Give the pipeline a clear goal.</h2>
        <p className="card-sub">A project brief, not a conversation. Include the outcome and what would prove it works.</p>
        <form onSubmit={(event) => { event.preventDefault(); prepareReview(); }}>
          <label className="field-label" htmlFor="quick-goal">What should change?</label>
          <textarea id="quick-goal" className="text-input text-area" value={quickGoal} disabled={!project || pending === 'Dispatch run'}
            placeholder={project ? 'Add a client invoice export. Keep existing totals unchanged and test the CSV output.' : 'Attach a project folder to write a goal.'}
            onChange={(event) => setQuickGoal(event.target.value)} aria-describedby="goal-help" rows={4} />
          <div className="goal-bottom"><p id="goal-help" className="helper">Nothing starts until you review and confirm.</p>
            <button ref={reviewButton} className="btn primary" type="submit" disabled={!project || !loaded || quickGoal.trim().length < 4 || pending !== null}>
              {pending === 'Prepare review' ? 'Preparing…' : 'Review run'} <ArrowRight size={15} /></button></div>
        </form>
      </section>
      <section className="card voice-panel" aria-labelledby="voice-title">
        <span className="eyebrow">ALSO WITH YOUR VOICE</span><h2 id="voice-title">Say it. Then check it.</h2>
        <p className="card-sub">Capture a goal with <kbd>{hotkey}</kbd>. Audio is sent to Groq for transcription; it is not offline. Capture auto-stops after 120 seconds. Upload limit: 25 MB.</p>
        <div className="voice-status" role="status"><span className={`mic-orb ${state}`}><Mic size={18} /></span>
          <div><strong>{snapshot.message ?? pillIdleLine(state)}</strong><span className="utility">{state}</span></div></div>
        {snapshot.transcript ? <p className="transcript">“{snapshot.transcript}”</p> : null}
        <div className="row-flex">
          {state === 'recording' ? <button className="btn" onClick={() => window.tawnyOrch.send('STOP')}><Square size={14} />Finish capture</button>
            : state === 'confirming' ? <button className="btn primary" onClick={() => window.tawnyOrch.send('CONFIRM')}><Check size={15} />Confirm voice action</button>
            : ['idle', 'done', 'failed', 'cancelled'].includes(state) ? <button className="btn" disabled={pending !== null || !loaded} onClick={() => {
              void perform('Start voice capture', async () => { await window.tawnyOrch.enterBackground(); window.tawnyOrch.send('HOTKEY'); });
            }}><Mic size={15} />Capture a goal</button> : null}
          {!['idle', 'done', 'failed', 'cancelled'].includes(state) ? <button className="btn subtle" onClick={() => window.tawnyOrch.send('CANCEL')}>Cancel</button>
                      : <button className="btn subtle small" disabled={pending !== null || !loaded} onClick={() => {
                        void perform('Enter background', async () => window.tawnyOrch.enterBackground());
                      }}>Run in background</button>}
        </div>
      </section>
    </div>
    <section className="card" aria-labelledby="terminals-title">
      <div className="section-top"><div><span className="eyebrow">BRING YOUR OWN TOOLS</span><h2 id="terminals-title">Agent terminals <span className="count-label">{loaded ? `${installed} detected` : 'Checking…'}</span></h2></div>
        <button className="btn small" disabled={pending !== null || !loaded} onClick={() => {
          void perform('Detect terminals', async () => setAgents(await window.tawnyOrch.detectAgents()));
        }}><RefreshCw size={14} />{pending === 'Detect terminals' ? 'Detecting…' : 'Detect again'}</button></div>
      <p className="card-sub">Tawny detects installed agent commands and runs them using their current CLI configuration. Detection reports installation and version; it does not test account access or provider usage.</p>
      <div className="agent-grid">{agents.map((agent) => <div className="agent-tile" key={agent.id}>
        <div className="section-top"><strong><Bot size={16} />{agent.label}</strong><span className={`chip ${agent.detected ? 'green' : 'slate'}`}>{agent.detected ? 'Detected' : agent.health === 'probe_failed' ? 'Probe failed' : 'Not detected'}</span></div>
        <span className="utility">{agent.version || 'Version not reported'}</span>
        <p className="helper">{agent.authenticated === true ? 'Sign-in reported' : agent.authenticated === false ? 'Sign-in required' : 'Sign-in not verified'} · {agent.remainingRequests === undefined ? 'Quota not reported' : `${agent.remainingRequests} requests reported`}</p>
        {!agent.detected && agent.installHint ? <code className="install-hint">{agent.installHint}</code> : null}
      </div>)}</div>
      {loaded && !agents.length ? <p className="empty-inline">No terminal inventory returned. Use Detect again to check installed tools.</p> : null}
    </section>
    {review ? <ReviewDialog review={review} pending={pending === 'Dispatch run'} onClose={closeReview} onConfirm={confirm} /> : null}
  </>;
}

function ReviewDialog({ review, pending, onClose, onConfirm }: { review: Review; pending: boolean; onClose: () => void; onConfirm: () => void }): ReactElement {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const { failure } = useContext(Feedback);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    backButtonRef.current?.focus();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  return <dialog ref={dialogRef} className="review-dialog" aria-labelledby="review-title" aria-describedby="review-description"
    onCancel={(event) => { event.preventDefault(); if (!pending) onClose(); }}>
    <span className="eyebrow">BEFORE THE TERMINALS START</span><h2 id="review-title">Review this run.</h2>
    <p id="review-description" className="card-sub">Confirm the exact folder, brief and stage order. Dispatch may modify project files and use provider allowances.</p>
        <ProviderNotice />
    <dl className="review-facts"><dt>Project folder</dt><dd><strong>{review.project.name}</strong><code>{review.project.path}</code></dd>
      <dt>Goal</dt><dd className="review-goal">{review.goal}</dd><dt>Pipeline</dt><dd>{review.config.templateId}</dd></dl>
    <HandoffRail stages={review.config.stages} />
    <div className="review-checks">{review.config.stages.map((stage) => <div key={stage.id}><strong>{stage.title}</strong>
      <span>{stage.acceptanceCommands.length ? stage.acceptanceCommands.join(' · ') : 'No acceptance command configured'}</span></div>)}</div>
    <p className="info-note">Local-first is not offline-only. Agent CLIs may send code and your goal to their configured providers and may incur usage charges. Review your model and provider settings in that CLI before dispatch.</p>
    {failure ? <div className="error-notice" role="alert"><div><strong>{failure.title}</strong><p>{failure.detail}</p></div></div> : null}
    <div className="dialog-actions"><button ref={backButtonRef} className="btn" disabled={pending} onClick={onClose}>Back to goal</button>
      <button className="btn primary" disabled={pending} onClick={onConfirm}>{pending ? 'Dispatching…' : 'Confirm & dispatch'}<ArrowRight size={15} /></button></div>
  </dialog>;
}

function PipelineEditor({ project, templates, config, setConfig, agents }: {
  project: ProjectAttachment | null; templates: PipelineTemplate[]; config: ProjectConfig | null;
  setConfig: (config: ProjectConfig) => void; agents: AgentStatus[];
}): ReactElement {
  const [pending, perform] = useOperation();
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [config, project?.path]);
  function change(next: ProjectConfig): void { setSaved(false); setConfig(next); }
  function updateStage(id: string, patch: Partial<StageSpec>): void {
    if (config) change({ ...config, stages: config.stages.map((stage) => stage.id === id ? { ...stage, ...patch } : stage) });
  }
  function addStage(role: StageSpec['role']): void {
    if (!config) return;
    const base = role.replace(/[^a-z0-9_-]/gi, '-');
    let id = base;
    let suffix = 2;
    while (config.stages.some((stage) => stage.id.toLowerCase() === id.toLowerCase())) id = `${base}-${suffix++}`;
    const title = role === 'deliver' ? 'Deliver summary' : `${role[0].toUpperCase()}${role.slice(1)}`;
    change({ ...config, templateId: '__custom__', stages: [...config.stages, {
      id, title, role, agentId: null, acceptanceCommands: [], allowedFiles: [], forbiddenFiles: [], retries: 1
    }] });
  }
  return <>
    <PageHeading eyebrow="MAKE THE HANDOFFS EXPLICIT" title="Your delivery pipeline.">Set the stage order, choose tools and define the checks that matter to this project.</PageHeading>
    {!project ? <EmptyState title="Start with a project folder." description="Attach a folder in Cockpit before editing its pipeline." />
      : !config ? <div className="card" role="status">Waiting for the project pipeline. If loading failed, reattach the folder in Cockpit.</div> : <section className="card">
        <div className="section-top"><div><h2>{project.name}</h2><p className="card-sub">Changes stay in this editor until you save. A run review reads the saved pipeline.</p></div>
          <span className="utility">Project pipeline settings · stored in a hidden Tawny metadata folder</span></div>
        <div className="pipeline-toolbar"><div><label className="field-label" htmlFor="pipeline-template">Start from a template</label>
          <select id="pipeline-template" className="select-input" disabled={pending !== null}
            value={templates.some((item) => item.id === config.templateId) ? config.templateId : '__custom__'}
            onChange={(event) => { const template = templates.find((item) => item.id === event.target.value); if (template) change({ ...config, templateId: template.id, stages: template.stages.map((stage) => ({ ...stage })) }); }}>
            <option value="__custom__" disabled>Custom pipeline</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
          </select></div><p className="helper">{templates.find((item) => item.id === config.templateId)?.description || 'Stage assignments are explicit; unassigned stages use the router.'}</p></div>
        {config.stages.length ? <HandoffRail stages={config.stages} /> : <p className="empty-inline">Choose a template to add stages.</p>}
        <div className="stage-editors">{config.stages.map((stage, index) => <fieldset className="stage-editor" key={stage.id} disabled={pending !== null}>
          <legend><span className="utility">{String(index + 1).padStart(2, '0')}</span> {stage.title || stage.role}</legend>
          <button className="btn small subtle remove-stage" disabled={pending !== null || config.stages.length <= 1} aria-label={`Remove ${stage.title || stage.role} stage`}
            onClick={() => change({ ...config, templateId: '__custom__', stages: config.stages.filter((candidate) => candidate.id !== stage.id) })}><X size={13} />Remove stage</button>
          <div className="stage-fields"><div><label className="field-label" htmlFor={`agent-${stage.id}`}>Agent terminal · {stage.role}</label>
            <select id={`agent-${stage.id}`} className="select-input" value={stage.agentId ?? '__auto__'} onChange={(event) => updateStage(stage.id, { agentId: event.target.value === '__auto__' ? null : event.target.value })}>
              <option value="__auto__">Router selects</option>
              {stage.agentId && !agents.some((agent) => agent.id === stage.agentId && agent.roles.includes(stage.role)) ? <option value={stage.agentId}>{agents.find((agent) => agent.id === stage.agentId)?.label ?? stage.agentId} (incompatible with {stage.role})</option> : null}
              {agents.filter((agent) => agent.roles.includes(stage.role)).map((agent) => <option key={agent.id} value={agent.id}>{agent.label}{agent.detected ? '' : ' (not detected)'}</option>)}
            </select></div><div><label className="field-label" htmlFor={`retry-${stage.id}`}>Retries before escalation</label>
              <input id={`retry-${stage.id}`} type="number" min={0} max={5} step={1} className="text-input" value={stage.retries}
                onChange={(event) => updateStage(stage.id, { retries: Math.max(0, Math.min(5, Math.floor(Number(event.target.value) || 0))) })} /></div></div>
          <label className="field-label" htmlFor={`checks-${stage.id}`}>Acceptance commands · one per line</label>
          <textarea id={`checks-${stage.id}`} className="text-input command-input" rows={2} value={stage.acceptanceCommands.join('\n')}
            placeholder="For example: pnpm test" onChange={(event) => updateStage(stage.id, { acceptanceCommands: event.target.value.split('\n') })} />
          <p className="helper">Only agents that declare support for this role are selectable. Access is checked again before dispatch. These commands execute in the project; only add commands you trust.</p>
        </fieldset>)}</div>
        <div className="pipeline-add-row"><label className="field-label" htmlFor="add-pipeline-stage">Optional handoff</label>
          <select id="add-pipeline-stage" className="select-input" value="" disabled={pending !== null}
            onChange={(event) => { if (event.target.value) addStage(event.target.value as StageSpec['role']); }}>
            <option value="">Add a stage…</option><option value="research">Research</option><option value="plan">Plan</option>
            <option value="execute">Execute</option><option value="test">Test</option><option value="review">Review</option><option value="deliver">Deliver summary</option>
          </select><p className="helper">Remove Research or any other stage when this goal does not need it. Stages can also be skipped from a running run.</p>
        </div>
        <div className="save-bar"><span className="helper" role="status">{saved ? 'Pipeline saved to this project.' : 'Save before reviewing a new run.'}</span>
          <button className="btn primary" disabled={pending !== null || !config.stages.length} onClick={() => {
            void perform('Save pipeline', async () => { await window.tawnyOrch.saveProjectConfig(project.path, {
              ...config, stages: config.stages.map((stage) => ({ ...stage, acceptanceCommands: stage.acceptanceCommands.map((command) => command.trim()).filter(Boolean) }))
            }); setSaved(true); });
          }}><Check size={15} />{pending ? 'Saving…' : 'Save pipeline'}</button></div>
      </section>}
  </>;
}

function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }): ReactElement {
  return <div className="card empty-state"><span className="empty-icon"><Workflow size={25} /></span><h2>{title}</h2><p>{description}</p>{action}</div>;
}

function RunsPage({ runs, events, logs, openRunId, setOpenRunId, agents, loaded, onStart, refreshing }: {
  runs: RunSnapshot[]; events: OrchEvent[]; logs: PipelineLog[]; openRunId: string | undefined; setOpenRunId: (id: string | undefined) => void;
  agents: AgentStatus[]; loaded: boolean; onStart: () => void; refreshing: boolean;
}): ReactElement {
  return <>
    <PageHeading eyebrow="THE RECORD OF THE WORK" title="Runs & evidence.">Inspect actual stage outcomes, checks and handoffs. A finished run is not, by itself, proof of correctness.</PageHeading>
    {refreshing ? <p className="helper" role="status">Refreshing run history…</p> : null}
    {!runs.length ? <EmptyState title={loaded ? 'No recorded runs yet.' : 'Loading recorded runs…'} description="Start with a goal in Cockpit. Routing, checks and failures will appear here as they are reported."
      action={<button className="btn primary" onClick={onStart}>Write a goal <ArrowRight size={15} /></button>} />
      : <div className="run-list">{runs.map((run) => <RunRow key={run.id} run={run} open={openRunId === run.id}
        onToggle={() => setOpenRunId(openRunId === run.id ? undefined : run.id)} agents={agents} logs={logs.filter((entry) => entry.runId === run.id).slice(-200)}
        events={events.filter((event) => event.runId === run.id).slice(-60)} />)}</div>}
  </>;
}

function RunRow({ run, open, onToggle, agents, logs, events }: {
  run: RunSnapshot; open: boolean; onToggle: () => void; agents: AgentStatus[]; logs: PipelineLog[]; events: OrchEvent[];
}): ReactElement {
  const [pending, perform] = useOperation();
  const [reassign, setReassign] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [openSessions, setOpenSessions] = useState<Record<string, boolean>>({});
  const chip = RUN_STATUS[run.status] ?? { label: run.status, cls: 'slate' };
  function escalate(stageId: string, action: 'assign' | 'complete' | 'skip'): void {
    void perform('Resolve stage', async () => { await window.tawnyOrch.escalateStage({ runId: run.id, stageId,
      reassignAgentId: action === 'assign' ? reassign[stageId] : undefined, manualComplete: action === 'complete',
      summary: action === 'complete' ? notes[stageId]?.trim() : undefined, skip: action === 'skip' }); });
  }
  return <article className={`card run-card${open ? ' expanded' : ''}`}>
    <div className="run-header"><button className="run-summary" aria-expanded={open} aria-controls={`run-${run.id}`} onClick={onToggle}>
      <span className={`chip ${chip.cls}`}>{chip.label}</span><span className="goal"><strong>{run.goal}</strong>
        <span>{run.projectName || run.projectPath} · {new Date(run.createdAt).toLocaleString()} · {run.stages.length} stages</span></span>
      {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</button>
      {['done', 'escalated', 'failed', 'cancelled'].includes(run.status) ? <button className="btn small subtle" disabled={pending !== null} onClick={() => {
        void perform('Open final report', async () => window.tawnyOrch.openRunArtifact({ runId: run.id, name: 'final_report' }));
      }}><ExternalLink size={13} />Open report</button> : null}
      {['pending', 'running', 'escalated'].includes(run.status) ? <button className="btn small danger" disabled={pending !== null} onClick={() => {
        void perform('Cancel run', async () => window.tawnyOrch.cancelRun(run.id));
      }}><Ban size={14} />{pending === 'Cancel run' ? 'Cancelling…' : 'Cancel run'}</button> : null}</div>
    <div id={`run-${run.id}`} hidden={!open} className="run-detail">
      <div className="run-facts"><code>{run.projectPath}</code><span className="utility">{run.stages.some((stage) => stage.artifacts.some((artifact) => artifact.name === 'selected_workspace')) ? 'Selected folder · changes apply here' : 'Run'} · {run.id}</span></div>
      <HandoffRail stages={[]} run={run} />
      <div className="stage-track">{run.stages.map((stage) => <section className="stage-line" key={stage.spec.id} aria-labelledby={`title-${run.id}-${stage.spec.id}`}>
        <div className="section-top"><div><h3 id={`title-${run.id}-${stage.spec.id}`}>{stage.spec.title}</h3><span className="utility">{stage.agentId ?? stage.spec.agentId ?? 'Router selects'} · attempt {stage.attempt}</span></div>
          <span className={`chip ${STATUS_CHIP[stage.status].cls}`}>{STATUS_CHIP[stage.status].label}</span></div>
        <div className="stage-controls">
          {stage.artifacts.some((artifact) => artifact.name === 'task_contract') ? <button className="btn small subtle" disabled={pending !== null}
            onClick={() => { void perform('Open task contract', async () => window.tawnyOrch.openRunArtifact({ runId: run.id, stageId: stage.spec.id, name: 'task_contract' })); }}>
            <ExternalLink size={13} />Open task contract</button> : null}
          {stage.artifacts.some((artifact) => artifact.name === 'worktree') ? <button className="btn small subtle" disabled={pending !== null}
            onClick={() => { void perform('Open run workspace', async () => window.tawnyOrch.openRunArtifact({ runId: run.id, stageId: stage.spec.id, name: 'worktree' })); }}>
            <FolderOpen size={13} />Open run workspace</button> : null}
          {stage.artifacts.some((artifact) => artifact.name === 'selected_workspace') ? <button className="btn small subtle" disabled={pending !== null}
            onClick={() => { void perform('Open selected project folder', async () => window.tawnyOrch.openRunArtifact({ runId: run.id, stageId: stage.spec.id, name: 'selected_workspace' })); }}>
            <FolderOpen size={13} />Open selected project folder</button> : null}
          {!['passed', 'skipped', 'cancelled', 'failed'].includes(stage.status) ? <button className="btn small subtle" disabled={pending !== null}
            onClick={() => escalate(stage.spec.id, 'skip')}>Skip stage</button> : null}
        </div>
        {stage.artifacts.some((artifact) => artifact.name === 'agent_session') ? (() => {
          const sessionEvents = logs.filter((entry) => entry.data?.stageId === stage.spec.id && entry.data?.attempt === String(stage.attempt) && entry.event.startsWith('agent.session.'));
          const started = [...sessionEvents].reverse().find((entry) => entry.event === 'agent.session.started');
          const finished = [...sessionEvents].reverse().find((entry) => entry.event === 'agent.session.finished');
          const live = stage.status === 'running' && (!finished || (started !== undefined && started.timestamp > finished.timestamp));
          const output = sessionEvents.filter((entry) => entry.event === 'agent.session.output').slice(-80);
          const expanded = openSessions[stage.spec.id] ?? stage.status === 'running';
          return <details className="agent-session" open={expanded} onToggle={(event) => {
            const next = event.currentTarget.open;
            setOpenSessions((current) => current[stage.spec.id] === next ? current : { ...current, [stage.spec.id]: next });
          }}>
            <summary><Terminal size={14} />{live ? 'Live agent session' : 'Agent session output'}
              <span className={`chip ${live ? 'blue' : finished?.data?.cancelled === 'true' ? 'slate' : 'green'}`}>{live ? started ? 'Process running' : 'Starting' : finished?.data?.cancelled === 'true' ? 'Stopped' : finished ? 'Exited' : 'No process output yet'}</span>
              {started?.data?.pid ? <code>PID {started.data.pid}</code> : null}</summary>
            <div className="session-content">
              <div className="session-meta"><span>{started?.data?.cwd ?? run.projectPath}</span>
                {stage.artifacts.some((artifact) => artifact.name === 'agent_session_id') && ['codex', 'opencode', 'gemini-cli', 'claude-code'].includes(stage.agentId ?? '') ? <button className="btn small subtle" disabled={pending !== null || live} onClick={(event) => {
                  event.preventDefault();
                  void perform('Resume agent session in terminal', async () => window.tawnyOrch.openAgentSession({ runId: run.id, stageId: stage.spec.id }));
                }}><Terminal size={12} />Resume agent session</button> : null}
                <button className="btn small subtle" disabled={pending !== null} onClick={(event) => {
                  event.preventDefault();
                  void perform('Open session log', async () => window.tawnyOrch.openRunArtifact({ runId: run.id, stageId: stage.spec.id, name: 'agent_session' }));
                }}><ExternalLink size={13} />Open session log</button></div>
              {!output.length ? <p className="helper">{live ? 'The process is active. Waiting for its first output line…' : 'No output was captured for this attempt.'}</p> :
                <div className="session-output" role="region" aria-label={`${stage.spec.title} agent session output`} aria-live="off" tabIndex={0}>
                  {output.map((entry, index) => <div className={`session-line ${entry.data?.stream === 'stderr' ? 'stderr' : ''}`} key={`${entry.timestamp}-${index}`}>
                    <time>{new Date(entry.timestamp).toLocaleTimeString()}</time><span>{entry.data?.stream ?? 'stdout'}›</span><code>{entry.message}</code>
                  </div>)}
                </div>}
              <p className="helper">Output is captured while the CLI runs. After exit, Resume agent session opens the provider’s saved conversation in a new terminal when that provider exposes a resumable session ID.</p>
            </div>
          </details>;
        })() : null}
        {stage.summary ? <div className="reported-summary"><span className="field-label">Reported summary</span><p>{stage.summary}</p></div> : null}
        {stage.failureReason ? <p className="reason">{stage.failureReason}</p> : null}
        <div className="evidence-block"><h4><ShieldCheck size={14} />Recorded checks</h4>
          {!stage.gates.length ? <p className="helper">No gate results recorded for this stage.</p> : <ul className="gate-list">{stage.gates.map((gate, index) => <li key={`${gate.gate}-${index}`}>
            <span className={`chip ${gate.result === 'pass' ? 'green' : 'red'}`}>{gate.result === 'pass' ? 'Pass' : gate.result === 'fail' ? 'Fail' : 'Error'}</span>
            <div><strong>{gate.gate}</strong><p>{gate.reason || 'No reason reported.'}</p></div>
          </li>)}</ul>}
          <h4>Artifact paths</h4>
          {stage.artifacts.some((artifact) => !artifact.name.startsWith('prior_attempt:')) ? <ul className="artifact-list">{stage.artifacts.filter((artifact) => !artifact.name.startsWith('prior_attempt:')).map((artifact, index) => <li key={`${artifact.path}-${index}`}>
            <div className="section-top"><strong>{artifact.name}</strong>
              {['task_contract', 'agent_session', 'agent_result', 'published_output'].includes(artifact.name) ? <button className="btn small subtle" disabled={pending !== null}
                onClick={() => { void perform(`Open ${artifact.name}`, async () => window.tawnyOrch.openRunArtifact({ runId: run.id, stageId: stage.spec.id, name: artifact.name as 'task_contract' | 'agent_session' | 'agent_result' | 'published_output' })); }}>
                <ExternalLink size={12} />Open</button> : null}</div><code tabIndex={0} aria-label={`${artifact.name} path`}>{artifact.path}</code></li>)}</ul>
            : <p className="helper">No artifact paths reported. Packet and report paths appear here when supplied by the engine.</p>}
          {stage.artifacts.some((artifact) => artifact.name.startsWith('prior_attempt:')) ? <p className="helper">Previous attempt details are preserved in the run report. Use Open report at the top of this run.</p> : null}
          <p className="helper">Task contracts and agent session logs can be opened from this run. Artifact paths are references; a path alone does not verify its contents.</p>
        </div>
        {stage.status === 'escalated' ? <fieldset className="escalation-box" disabled={pending !== null}><legend>Resolve this handoff</legend>
          <label className="field-label" htmlFor={`reassign-${run.id}-${stage.spec.id}`}>Retry with a detected terminal</label>
          <div className="row-flex"><select id={`reassign-${run.id}-${stage.spec.id}`} className="select-input" value={reassign[stage.spec.id] ?? ''}
            onChange={(event) => setReassign({ ...reassign, [stage.spec.id]: event.target.value })}><option value="">Choose terminal…</option>
            {agents.filter((agent) => agent.detected && agent.roles.includes(stage.spec.role)).map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}</select>
            <button className="btn small" disabled={!reassign[stage.spec.id]} onClick={() => escalate(stage.spec.id, 'assign')}><RefreshCw size={13} />Retry with agent</button></div>
          <label className="field-label" htmlFor={`note-${run.id}-${stage.spec.id}`}>Manual completion note</label>
          <input id={`note-${run.id}-${stage.spec.id}`} className="text-input" value={notes[stage.spec.id] ?? ''} placeholder="What did you change and check?"
            onChange={(event) => setNotes({ ...notes, [stage.spec.id]: event.target.value })} />
          <p className="helper">Manual completion and skipping do not establish automated verification.</p>
          <div className="row-flex"><button className="btn small" disabled={!notes[stage.spec.id]?.trim()} onClick={() => escalate(stage.spec.id, 'complete')}>Record manual completion</button>
            <button className="btn small subtle" onClick={() => escalate(stage.spec.id, 'skip')}>Skip stage</button><span className="helper" role="status">{pending ? 'Updating stage…' : ''}</span></div>
        </fieldset> : null}
      </section>)}</div>
      <details className="event-details"><summary>Run event ledger <span className="utility">{events.length} retained events</span></summary>
        <EventLog events={events} label="Run events" /></details>
    </div>
  </article>;
}

function EventLog({ events, label }: { events: OrchEvent[]; label: string }): ReactElement {
  return <div className="log-stream" role="region" aria-label={label} tabIndex={0}>
    {!events.length ? <p className="helper">No events received.</p> : events.map((event, index) => <div key={`${event.ts}-${index}`} className={`line ${event.level}`}>
      <time>{new Date(event.ts).toLocaleTimeString()}</time> {event.stageId ? `[${event.stageId}] ` : ''}{event.message}
      {event.data ? <dl className="event-data">{Object.entries(event.data).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl> : null}
    </div>)}
  </div>;
}

function SettingsPage({ settings, setSettings, logs }: {
  settings: AppSettings | null; setSettings: (settings: AppSettings) => void; logs: PipelineLog[];
}): ReactElement {
  const [draft, setDraft] = useState<AppSettings | null>(settings);
  const [saved, setSaved] = useState(false);
  const [pending, perform] = useOperation();
  useEffect(() => { setDraft(settings); }, [settings]);
  function save(): void {
    if (!draft) return;
    void perform('Save settings', async () => {
      const next = draft;
      await window.tawnyOrch.saveSettings(next);
      setSettings(next); setDraft(next); setSaved(true);
    });
  }
  return <>
    <PageHeading eyebrow="LOCAL CONTROL, CLEAR BOUNDARIES" title="Make it work for you.">Keep your own tools and accounts. Understand what stays here and what leaves this device.</PageHeading>
    {!draft ? <div className="card" role="status">Settings have not loaded. If loading failed, reopen the app before making changes; existing settings will not be overwritten.</div> : <>
      <form className="settings-form" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <section className="card" aria-labelledby="voice-settings"><h2 id="voice-settings">Voice & transcription</h2>
        <p className="card-sub">Optional for typed runs. Voice sends audio to Groq; an API key, network access and provider allowance are required. Capture auto-stops at 120 seconds, and audio over 25 MB is not uploaded.</p>
        <fieldset className="settings-fields" disabled={pending !== null}>
          <label className="field-label" htmlFor="groq">Groq API key</label>
          <input id="groq" className="text-input" type="password" autoComplete="off" spellCheck={false} value={draft.groqApiKey} placeholder="gsk_…"
            onChange={(event) => { setSaved(false); setDraft({ ...draft, groqApiKey: event.target.value }); }} />
          <label className="field-label" htmlFor="voice-hotkey">Capture hotkey</label>
          <input id="voice-hotkey" className="text-input" value={draft.prefs.hotkey} placeholder="Control+Alt+Space"
            onChange={(event) => { setSaved(false); setDraft({ ...draft, prefs: { ...draft.prefs, hotkey: event.target.value } }); }} />
          <label className="check-label"><input type="checkbox" checked={draft.prefs.alwaysRoute}
            onChange={(event) => { setSaved(false); setDraft({ ...draft, prefs: { ...draft.prefs, alwaysRoute: event.target.checked } }); }} />Route every capture without requiring a wake phrase</label>
          <p className="helper">Wake phrases: {draft.prefs.wakePhrases.length ? draft.prefs.wakePhrases.map((phrase) => `“${phrase}”`).join(', ') : 'none configured'}. Voice actions still follow the existing confirmation flow.</p>
        </fieldset>
        <div className="save-bar"><span className="helper" role="status">{saved ? 'Settings saved.' : 'Changes apply when saved.'}</span>
          <button className="btn primary" type="submit" disabled={pending !== null}><Check size={15} />{pending ? 'Saving…' : 'Save settings'}</button></div>
      </section>
      </form>
      <section className="card privacy-panel" aria-labelledby="local-settings"><ShieldCheck size={24} /><div><h2 id="local-settings">Local-first. Provider settings stay with your CLI.</h2>
        <p>Project work runs through installed agent terminals. Their sign-in, models, network use, rate limits and billing remain with their providers. Configure a local model in that agent's CLI and select the detected terminal in your pipeline.</p>
        <p>Typed goals do not need a transcription key. Local artifact paths and event records are evidence references—not a guarantee that checks passed.</p></div></section>
    </>}
    <section className="card" aria-labelledby="diagnostics-title"><div className="section-top"><div><span className="eyebrow">DIAGNOSTICS</span><h2 id="diagnostics-title">Recent activity</h2></div><span className="utility">Latest {Math.min(logs.length, 100)} entries</span></div>
      <p className="card-sub">Review locally recorded messages when something fails. Check log content before sharing it.</p>
      <div className="log-stream" role="region" aria-label="Diagnostic logs" tabIndex={0}>
        {!logs.length ? <p className="helper">No log entries received.</p> : logs.slice(-100).map((entry, index) => <div className={`line ${entry.level}`} key={`${entry.timestamp}-${index}`}>
          <time>{new Date(entry.timestamp).toLocaleTimeString()}</time> {entry.event}: {entry.message}
        </div>)}
      </div>
    </section>
  </>;
}

function pillIdleLine(state: string): string {
  switch (state) {
    case 'arming': return 'Preparing the microphone…'; case 'recording': return 'Listening to your goal…';
    case 'finalizing': return 'Finishing audio capture…'; case 'transcribing': return 'Transcribing with Groq…';
    case 'gating': return 'Checking wake phrase…'; case 'deciding': return 'Reading your intent…';
    case 'confirming': return 'Review your voice action'; case 'handling': return 'Preparing pipeline…';
    case 'dispatching': return 'Dispatching agents…'; case 'done': return 'Voice action completed';
    case 'failed': return 'Voice action failed. Check diagnostics.'; case 'cancelled': return 'Capture cancelled';
    default: return 'Ready when you are';
  }
}

function VoicePill({ snapshot, hotkey }: { snapshot: OverlaySnapshot; hotkey: string }): ReactElement {
  const { failure } = useContext(Feedback);
  const state = snapshot.state;
  const mainLine = failure ? `${failure.title} ${failure.detail}` : snapshot.message ?? snapshot.transcript ?? pillIdleLine(state);
  return <div className="pill-page"><div className="tawny-pill">
    <span className={`mic-orb ${failure ? 'failed' : state}`}>{state === 'done' ? <Check size={17} /> : state === 'failed' || failure ? <X size={17} /> : <Mic size={17} />}</span>
    <div className="pill-status" role="status"><div className="pill-text" title={mainLine}>{mainLine}
      <span className="sub">{state === 'confirming' ? 'Confirm to dispatch · Esc to cancel' : state === 'recording' ? `${hotkey} or stop · auto-stop 120s · 25 MB max` : hotkey}</span></div></div>
    <div className="pill-actions">
      {state === 'recording' ? <button className="action-btn accent" aria-label="Finish capture" onClick={() => window.tawnyOrch.send('STOP')}><Square size={14} /></button> : null}
      {state === 'confirming' ? <button className="action-btn accent" aria-label="Confirm and dispatch voice action" onClick={() => window.tawnyOrch.send('CONFIRM')}><ArrowRight size={17} /></button> : null}
      {!['idle', 'done', 'failed', 'cancelled'].includes(state) ? <button className="action-btn" aria-label="Cancel voice capture" onClick={() => window.tawnyOrch.send('CANCEL')}><X size={16} /></button> : null}
    </div>
  </div></div>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><FeedbackProvider><App /></FeedbackProvider></StrictMode>);
