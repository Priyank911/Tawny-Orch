import { assign, createMachine } from 'xstate';
import type { OverlayState } from '../../shared/contracts';

// Voice capture lifecycle — Tawny parity with `injecting` replaced by
// `dispatching` (the run is handed to the orchestration engine).
export interface PipelineContext {
  state: OverlayState;
  message?: string;
  rms: number;
  elapsedMs: number;
  runId?: string;
}

export type PipelineEvent =
  | { type: 'HOTKEY' }
  | { type: 'AUDIO_READY' }
  | { type: 'STOP' }
  | { type: 'CANCEL' }
  | { type: 'STAGE'; stage: OverlayState }
  | { type: 'CONFIRM' }
  | { type: 'DISPATCHED'; runId?: string }
  | { type: 'SUCCESS'; message?: string }
  | { type: 'FAIL'; message: string };

export const pipelineMachine = createMachine({
  types: {} as { context: PipelineContext; events: PipelineEvent },
  id: 'tawnyOrch',
  initial: 'idle',
  context: { state: 'idle', rms: 0, elapsedMs: 0 },
  states: {
    idle: { on: { HOTKEY: 'arming' } },
    arming: {
      on: {
        AUDIO_READY: 'recording',
        CANCEL: 'cancelled',
        FAIL: { target: 'failed', actions: assign({ message: ({ event }) => event.message }) }
      }
    },
    recording: {
      on: {
        STOP: 'finalizing',
        CANCEL: 'cancelled',
        FAIL: { target: 'failed', actions: assign({ message: ({ event }) => event.message }) }
      }
    },
    finalizing: {
      on: {
        STAGE: [
          { guard: ({ event }) => event.stage === 'deciding', target: 'deciding' },
          { guard: ({ event }) => event.stage === 'dispatching', target: 'dispatching' },
          { target: 'transcribing' }
        ],
        SUCCESS: 'done',
        CANCEL: 'cancelled',
        FAIL: { target: 'failed', actions: assign({ message: ({ event }) => event.message }) }
      }
    },
    transcribing: {
      on: {
        STAGE: [
          { guard: ({ event }) => event.stage === 'deciding', target: 'deciding' },
          { guard: ({ event }) => event.stage === 'dispatching', target: 'dispatching' },
          { target: 'gating' }
        ],
        SUCCESS: 'done',
        FAIL: { target: 'failed', actions: assign({ message: ({ event }) => event.message }) },
        CANCEL: 'cancelled'
      }
    },
    gating: {
      on: {
        STAGE: [
          { guard: ({ event }) => event.stage === 'handling', target: 'handling' },
          { guard: ({ event }) => event.stage === 'dispatching', target: 'dispatching' },
          { target: 'deciding' }
        ],
        SUCCESS: 'done',
        FAIL: { target: 'failed', actions: assign({ message: ({ event }) => event.message }) },
        CANCEL: 'cancelled'
      }
    },
    deciding: {
      on: {
        STAGE: [
          { guard: ({ event }) => event.stage === 'handling', target: 'handling' },
          { guard: ({ event }) => event.stage === 'dispatching', target: 'dispatching' },
          { target: 'confirming' }
        ],
        SUCCESS: 'done',
        FAIL: { target: 'failed', actions: assign({ message: ({ event }) => event.message }) },
        CANCEL: 'cancelled'
      }
    },
    confirming: { on: { CONFIRM: 'handling', HOTKEY: 'handling', CANCEL: 'cancelled' } },
    handling: {
      on: {
        STAGE: 'dispatching',
        SUCCESS: 'done',
        FAIL: { target: 'failed', actions: assign({ message: ({ event }) => event.message }) },
        CANCEL: 'cancelled'
      }
    },
    dispatching: {
      on: {
        DISPATCHED: { target: 'done', actions: assign({ runId: ({ event }) => event.runId }) },
        SUCCESS: 'done',
        FAIL: { target: 'failed', actions: assign({ message: ({ event }) => event.message }) },
        CANCEL: 'cancelled'
      }
    },
    done: { after: { 4000: 'idle' }, on: { HOTKEY: 'arming' } },
    failed: { after: { 6000: 'idle' }, on: { HOTKEY: 'arming' } },
    cancelled: { after: { 250: 'idle' } }
  }
});

export function overlayState(value: string): OverlayState {
  const allowed: OverlayState[] = [
    'idle', 'arming', 'recording', 'finalizing', 'transcribing', 'gating',
    'deciding', 'confirming', 'handling', 'dispatching', 'done', 'failed', 'cancelled'
  ];
  return allowed.includes(value as OverlayState) ? value as OverlayState : 'idle';
}
