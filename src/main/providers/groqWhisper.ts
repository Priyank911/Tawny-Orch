import { z } from 'zod';

const responseSchema = z.object({ text: z.string() });
const MAX_DIRECT_UPLOAD_BYTES = 25 * 1024 * 1024;

function transcriptionTimeoutMs(bytes: number): number {
  return Math.min(180_000, Math.max(60_000, 45_000 + Math.ceil(bytes / 250_000) * 5_000));
}

function isTimeoutError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'name' in error && (error as { name?: unknown }).name === 'TimeoutError');
}

// Groq Whisper transcription — Tawny parity (whisper-large-v3-turbo).
// The renderer rotates recordings into 60-second WebM segments before this runs.
export async function transcribeWithGroq(
  apiKey: string,
  audio: Uint8Array | readonly Uint8Array[],
  mimeType = 'audio/webm'
): Promise<string> {
  if (!apiKey.trim()) throw new Error('Groq API key is not configured. Open Settings and add it.');
  const segments = Array.isArray(audio) ? audio : [audio];
  if (segments.length === 0 || segments.some((segment) => segment.byteLength === 0)) {
    throw new Error('No microphone audio was captured.');
  }
  if (segments.length === 1 && segments[0].byteLength > MAX_DIRECT_UPLOAD_BYTES) {
    throw new Error('The recording is larger than Groq\'s direct upload limit. Try a shorter recording.');
  }

  const transcripts: string[] = [];
  for (const [index, segment] of segments.entries()) {
    const audioBuffer = new ArrayBuffer(segment.byteLength);
    new Uint8Array(audioBuffer).set(segment);

    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: mimeType }), `tawny-orch-${index + 1}.webm`);
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    if (transcripts.length > 0) {
      form.append('prompt', transcripts.join(' ').slice(-900));
    }

    let response: Response;
    try {
      response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(transcriptionTimeoutMs(segment.byteLength))
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new Error(`Groq transcription timed out on segment ${index + 1} of ${segments.length}.`);
      }
      throw error;
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const detail = body && typeof body === 'object' && 'error' in body
        ? String((body as { error?: { message?: unknown } }).error?.message ?? '')
        : '';
      throw new Error(detail || `Groq transcription failed with HTTP ${response.status}.`);
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) throw new Error(`Groq returned an invalid transcription response for segment ${index + 1}.`);
    const text = parsed.data.text.trim();
    if (text) transcripts.push(text);
  }

  return transcripts.join(' ').trim();
}
