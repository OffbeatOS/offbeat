import { type ChildProcessByStdio, execFile, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';

/** What transcoded audio is: MP3 plays in every browser, including Safari on iOS. */
export const TRANSCODE_TYPE = 'audio/mpeg';
const BITRATE = '256k';

/** ffmpeg is missing or would not start. */
export class TranscoderUnavailable extends Error {}

/**
 * ffmpeg, for files the browser cannot play directly. Each stream is one
 * ffmpeg process writing MP3 to stdout, started at a given second (the
 * player seeks a transcoded track by asking for a new stream from there).
 * The caller kills the process when the listener goes away.
 */
export class Transcoder {
  private checked: Promise<string | null> | null = null;

  constructor(
    private readonly ffmpeg: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** ffmpeg's version (for example "9.0.2"), or null when it is not installed. Checked once. */
  version(): Promise<string | null> {
    this.checked ??= new Promise((resolve) => {
      execFile(this.ffmpeg, ['-hide_banner', '-version'], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
        if (error) {
          this.log.warn({ ffmpeg: this.ffmpeg, err: error }, 'ffmpeg not found: formats the browser cannot play will not play');
          resolve(null);
          return;
        }
        resolve(/ffmpeg version (\S+)/.exec(stdout)?.[1] ?? 'unknown');
      });
    });
    return this.checked;
  }

  /** Starts ffmpeg for a file from `startSeconds`. Rejects with TranscoderUnavailable if it cannot start. */
  async start(file: string, startSeconds: number): Promise<ChildProcessByStdio<null, Readable, Readable>> {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      ...(startSeconds > 0 ? ['-ss', startSeconds.toFixed(3)] : []),
      '-i',
      file,
      '-map',
      '0:a:0',
      '-vn',
      '-c:a',
      'libmp3lame',
      '-b:a',
      BITRATE,
      '-f',
      'mp3',
      'pipe:1',
    ];
    const child = spawn(this.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (error) => reject(new TranscoderUnavailable(`ffmpeg could not start: ${error.message}`)));
    });
    let errors = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (errors.length < 2000) errors += chunk.toString();
    });
    child.on('close', (code, signal) => {
      // Killed because the listener left (skipped, paused for long, or seeked): not a failure.
      if (code && !signal) this.log.warn({ file, code, errors: errors.trim() }, 'Transcoding failed');
    });
    return child;
  }
}
