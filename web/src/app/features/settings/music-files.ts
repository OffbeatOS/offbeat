import { ChangeDetectionStrategy, Component, type OnInit, computed, inject, signal } from '@angular/core';
import type { MusicFilesCheck, MusicFilesView } from '@offbeat/shared';
import { Api, ApiError } from '../../core/api';
import { timeAgo } from '../../shared/format';

/**
 * Settings, Lidarr, Music files: Offbeat plays straight from the folders
 * Lidarr manages, read-only. Each of Lidarr's root folders is read at the
 * same path unless Offbeat sees it somewhere else (a different mount in
 * Docker, a share on another machine). Check reads each folder and the start
 * of a sample of files, and says what is wrong in plain words.
 */
@Component({
  selector: 'ob-music-files',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 20px;
      max-width: 640px;
    }

    .head {
      h3 {
        font-size: 15px;
        font-weight: 600;
      }

      p {
        margin-top: 4px;
        font-size: 13px;
        color: var(--text-3);
        line-height: 1.5;
      }
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-label);
    }

    .mono {
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      font-size: 13px;
    }

    .hint {
      font-size: 12px;
      font-weight: 400;
      color: var(--text-3);
      line-height: 1.45;
    }

    .buttons {
      display: flex;
      gap: 8px;

      .btn {
        height: 36px;
      }
    }

    .btn-soft {
      background: var(--surface-3);
      color: var(--text-soft);

      &:hover:not(:disabled) {
        background: var(--surface-4);
      }
    }

    .status {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 14px 16px;
      border-radius: 10px;
      background: var(--surface);
      border: 1px solid var(--border-sidebar);
    }

    .summary {
      display: flex;
      align-items: center;
      gap: 10px;

      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--status-failed);
        flex-shrink: 0;

        &.on {
          background: var(--status-progress);
        }
      }

      .what {
        flex-grow: 1;
        font-size: 14px;
        font-weight: 500;
      }

      .when {
        font-size: 13px;
        color: var(--text-3);
      }
    }

    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    li {
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-size: 13px;

      .path {
        color: var(--text-2);
        overflow-wrap: anywhere;
      }

      .reason {
        color: var(--status-failed);
      }
    }

    .error {
      font-size: 13px;
      color: var(--status-failed);
      line-height: 1.45;
    }
  `,
  template: `
    <div class="head">
      <h3>Music files</h3>
      <p>
        Offbeat plays music straight from the folders Lidarr manages, and only ever reads them. If Offbeat sees a folder at a
        different path than Lidarr does, enter where Offbeat can read it.
      </p>
    </div>

    @if (view(); as v) {
      @for (folder of v.folders; track folder.lidarrPath; let i = $index) {
        <label class="field">
          Lidarr's {{ folder.lidarrPath }}, as Offbeat sees it
          <input
            class="input mono"
            spellcheck="false"
            [placeholder]="folder.lidarrPath"
            [value]="paths()[i] ?? ''"
            (input)="setPath(i, $any($event.target).value)"
          />
        </label>
      } @empty {
        <p class="hint">Lidarr has no root folders yet.</p>
      }
      <span class="hint">
        Leave it empty when Offbeat reads the folder at the same path, for example when both containers mount the music at /music.
        In Docker, mount the music folder read-only (for example -v /mnt/music:/music:ro).
      </span>

      <div class="buttons">
        <button class="btn btn-primary" type="button" [disabled]="busy()" (click)="saveAndCheck()">
          {{ busy() === 'save' ? 'Checking' : 'Save and Check' }}
        </button>
        @if (v.lastCheck) {
          <button class="btn btn-soft" type="button" [disabled]="busy()" (click)="check()">
            {{ busy() === 'check' ? 'Checking' : 'Check Again' }}
          </button>
        }
      </div>

      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }

      @if (v.lastCheck; as c) {
        <div class="status" role="status">
          <div class="summary">
            <span class="dot" [class.on]="c.ok" aria-hidden="true"></span>
            <span class="what">{{ summary(c) }}</span>
            <span class="when">{{ when(c) }}</span>
          </div>
          @if (!c.ok) {
            <ul>
              @for (folder of unreadableFolders(); track folder.lidarrPath) {
                <li>
                  <span class="path mono">{{ folder.offbeatPath }}</span>
                  <span class="reason">{{ folder.reason }}</span>
                </li>
              }
              <!-- An unreadable folder explains every file in it, so its files are not listed too. -->
              @for (problem of unreadableFolders().length ? [] : c.files.problems; track problem.lidarrPath) {
                <li>
                  <span class="path mono">{{ problem.offbeatPath ?? problem.lidarrPath }}</span>
                  <span class="reason">{{ problem.reason }}</span>
                </li>
              }
            </ul>
          }
        </div>
      }
    } @else if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
  `,
})
export class MusicFiles implements OnInit {
  private readonly api = inject(Api);

  protected readonly view = signal<MusicFilesView | null>(null);
  /** What each folder's field holds: empty means Lidarr's own path. */
  protected readonly paths = signal<string[]>([]);
  protected readonly busy = signal<'save' | 'check' | null>(null);
  protected readonly error = signal('');

  protected readonly unreadableFolders = computed(() => (this.view()?.lastCheck?.folders ?? []).filter((f) => !f.readable));

  async ngOnInit() {
    try {
      this.take(await this.api.get<MusicFilesView>('settings/music-files'));
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Could not load the music folders');
    }
  }

  protected setPath(index: number, value: string) {
    this.paths.update((paths) => paths.map((p, i) => (i === index ? value : p)));
  }

  protected summary(check: MusicFilesCheck): string {
    if (check.ok) return `Offbeat can read your music. Checked ${check.files.checked} ${check.files.checked === 1 ? 'file' : 'files'}.`;
    if (check.folders.some((f) => !f.readable)) return 'Offbeat cannot read a music folder';
    return `Offbeat could read ${check.files.readable} of ${check.files.checked} files it tried`;
  }

  protected when(check: MusicFilesCheck): string {
    return `Checked ${timeAgo(check.at)}`;
  }

  protected async saveAndCheck() {
    const folders = (this.view()?.folders ?? []).map((folder, i) => ({ lidarrPath: folder.lidarrPath, offbeatPath: this.paths()[i]?.trim() ?? '' }));
    await this.run('save', async () => {
      await this.api.put<MusicFilesView>('settings/music-files', { folders });
      await this.runCheck();
    });
  }

  protected check() {
    return this.run('check', () => this.runCheck());
  }

  private async runCheck() {
    const lastCheck = await this.api.post<MusicFilesCheck>('settings/music-files/check', {});
    this.take({ ...(await this.api.get<MusicFilesView>('settings/music-files')), lastCheck });
  }

  private take(view: MusicFilesView) {
    this.view.set(view);
    this.paths.set(view.folders.map((f) => (f.mapped ? f.offbeatPath : '')));
  }

  private async run(kind: 'save' | 'check', action: () => Promise<void>) {
    this.busy.set(kind);
    this.error.set('');
    try {
      await action();
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Something went wrong. Try again.');
    } finally {
      this.busy.set(null);
    }
  }
}
