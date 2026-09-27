import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type OnInit,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import type {
  LidarrOptions,
  LidarrSettingsRequest,
  LidarrSettingsView,
  LidarrTestRequest,
} from '@offbeat/shared';
import { merge } from 'rxjs';
import { Api, ApiError } from '../../core/api';
import { FormField } from '../../shared/form-field/form-field';
import { Icon } from '../../shared/icon/icon';

type Status =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'connected'; version: string }
  | { kind: 'failed'; message: string };

/**
 * Lidarr address, API key, connection test, and defaults for new artists
 * (onboarding mockup). Used by the setup wizard and by Settings. The saved API
 * key is never sent to the browser; leaving the field blank keeps it.
 */
@Component({
  selector: 'ob-lidarr-form',
  imports: [ReactiveFormsModule, FormField, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './lidarr-form.scss',
  templateUrl: './lidarr-form.html',
})
export class LidarrForm implements OnInit {
  private readonly api = inject(Api);
  private readonly destroyRef = inject(DestroyRef);

  /** Saved settings when editing; null during first-run setup. */
  readonly existing = input<LidarrSettingsView | null>(null);
  readonly submitLabel = input('Continue');
  readonly saved = output<LidarrSettingsView>();

  protected readonly status = signal<Status>({ kind: 'idle' });
  protected readonly options = signal<LidarrOptions | null>(null);
  protected readonly saving = signal(false);
  protected readonly saveError = signal('');
  protected readonly hasSavedKey = computed(() => this.existing() !== null);
  protected readonly failureMessage = computed(() => {
    const status = this.status();
    return status.kind === 'failed' ? status.message : '';
  });

  protected readonly form = inject(FormBuilder).nonNullable.group({
    url: ['', Validators.required],
    apiKey: [''],
    qualityProfileId: [{ value: 0, disabled: true }, Validators.min(1)],
    metadataProfileId: [{ value: 0, disabled: true }, Validators.min(1)],
    rootFolderPath: [{ value: '', disabled: true }, Validators.required],
  });

  ngOnInit() {
    const existing = this.existing();
    if (existing) {
      this.form.patchValue(existing);
      // Loads the dropdowns with the saved key, keeping the saved choices.
      void this.test(existing);
    }

    // Any change to the connection invalidates the last test.
    const { url, apiKey } = this.form.controls;
    merge(url.valueChanges, apiKey.valueChanges)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (this.status().kind !== 'testing') this.setOptions(null);
        this.status.set({ kind: 'idle' });
      });
  }

  protected async test(keep?: LidarrSettingsView) {
    const { url, apiKey } = this.form.getRawValue();
    if (!url.trim()) {
      this.status.set({ kind: 'failed', message: 'Enter the Lidarr address first' });
      return;
    }
    this.status.set({ kind: 'testing' });
    this.saveError.set('');
    const request: LidarrTestRequest = { url, ...(apiKey.trim() ? { apiKey } : {}) };
    try {
      const options = await this.api.post<LidarrOptions>('setup/lidarr/test', request);
      this.setOptions(options, keep);
      this.status.set({ kind: 'connected', version: options.version });
    } catch (error) {
      this.setOptions(null);
      this.status.set({ kind: 'failed', message: messageOf(error) });
    }
  }

  protected async submit() {
    if (!this.options() || this.form.invalid) return;
    const value = this.form.getRawValue();
    const request: LidarrSettingsRequest = {
      url: value.url,
      qualityProfileId: Number(value.qualityProfileId),
      metadataProfileId: Number(value.metadataProfileId),
      rootFolderPath: value.rootFolderPath,
      ...(value.apiKey.trim() ? { apiKey: value.apiKey } : {}),
    };
    this.saving.set(true);
    this.saveError.set('');
    try {
      const saved = this.existing()
        ? await this.api.put<LidarrSettingsView>('settings/lidarr', request)
        : await this.api.post<LidarrSettingsView>('setup/lidarr', request);
      this.form.controls.apiKey.reset('', { emitEvent: false });
      this.saved.emit(saved);
    } catch (error) {
      this.saveError.set(messageOf(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected formatFree(bytes: number | null): string {
    if (bytes === null) return '';
    const tb = bytes / 1024 ** 4;
    return tb >= 1 ? `${tb.toFixed(1)} TB free` : `${Math.round(bytes / 1024 ** 3)} GB free`;
  }

  /** Fills the dropdowns, preferring saved choices, then the root folder's own defaults. */
  private setOptions(options: LidarrOptions | null, keep?: LidarrSettingsView) {
    this.options.set(options);
    const { qualityProfileId, metadataProfileId, rootFolderPath } = this.form.controls;
    const selects = [qualityProfileId, metadataProfileId, rootFolderPath];
    if (!options) {
      selects.forEach((control) => control.disable({ emitEvent: false }));
      return;
    }
    const has = <T>(list: T[], match: (item: T) => boolean) => list.some(match);
    const folder =
      options.rootFolders.find((f) => f.path === keep?.rootFolderPath) ?? options.rootFolders[0];
    const quality =
      [keep?.qualityProfileId, folder?.defaultQualityProfileId, options.qualityProfiles[0]?.id].find(
        (id) => id != null && has(options.qualityProfiles, (p) => p.id === id),
      ) ?? 0;
    const metadata =
      [keep?.metadataProfileId, folder?.defaultMetadataProfileId, options.metadataProfiles[0]?.id].find(
        (id) => id != null && has(options.metadataProfiles, (p) => p.id === id),
      ) ?? 0;
    this.form.patchValue(
      { rootFolderPath: folder?.path ?? '', qualityProfileId: quality, metadataProfileId: metadata },
      { emitEvent: false },
    );
    selects.forEach((control) => control.enable({ emitEvent: false }));
  }
}

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong';
}
