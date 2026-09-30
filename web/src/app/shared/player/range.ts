import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

/**
 * A thin slider for the player's progress and volume (Playing and Now
 * Playing mockups): a native range input, so keyboards and screen readers
 * work, drawn as a track with a filled part. While dragging it shows where
 * the thumb is, not where playback is, and only commits on release.
 */
@Component({
  selector: 'ob-range',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: flex;
      align-items: center;
      --range-height: 4px;
      --range-track: var(--track);
      --range-fill: var(--text);
    }

    input {
      appearance: none;
      -webkit-appearance: none;
      width: 100%;
      height: 16px;
      margin: 0;
      background: transparent;
      cursor: pointer;
    }

    input::-webkit-slider-runnable-track {
      height: var(--range-height);
      border-radius: calc(var(--range-height) / 2);
      background: linear-gradient(to right, var(--range-fill) var(--fill), var(--range-track) var(--fill));
    }

    input::-moz-range-track {
      height: var(--range-height);
      border-radius: calc(var(--range-height) / 2);
      background: linear-gradient(to right, var(--range-fill) var(--fill), var(--range-track) var(--fill));
    }

    input::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 13px;
      height: 13px;
      margin-top: calc((var(--range-height) - 13px) / 2);
      border-radius: 50%;
      background: #fff;
      border: 0;
      opacity: 0;
      transition: opacity 120ms ease;
    }

    input::-moz-range-thumb {
      width: 13px;
      height: 13px;
      border-radius: 50%;
      background: #fff;
      border: 0;
      opacity: 0;
      transition: opacity 120ms ease;
    }

    :host(.thumb) input::-webkit-slider-thumb,
    input:hover::-webkit-slider-thumb,
    input:focus-visible::-webkit-slider-thumb {
      opacity: 1;
    }

    :host(.thumb) input::-moz-range-thumb,
    input:hover::-moz-range-thumb,
    input:focus-visible::-moz-range-thumb {
      opacity: 1;
    }

    :host(.thumb) input::-webkit-slider-thumb {
      width: 15px;
      height: 15px;
      margin-top: calc((var(--range-height) - 15px) / 2);
    }

    input:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 4px;
      border-radius: 4px;
    }
  `,
  template: `
    <input
      type="range"
      min="0"
      [max]="max()"
      [step]="step()"
      [value]="shown()"
      [style.--fill]="percent() + '%'"
      [attr.aria-label]="label()"
      [attr.aria-valuetext]="valueText()"
      [disabled]="disabled()"
      (input)="drag($event)"
      (change)="commit($event)"
    />
  `,
})
export class Range {
  readonly value = input.required<number>();
  readonly max = input.required<number>();
  readonly step = input<number | 'any'>('any');
  readonly label = input.required<string>();
  readonly valueText = input<string>('');
  readonly disabled = input(false);
  /** While dragging, for a live readout. */
  readonly dragging = output<number | null>();
  readonly changed = output<number>();

  private readonly held = signal<number | null>(null);
  protected readonly shown = computed(() => this.held() ?? this.value());
  protected readonly percent = computed(() => {
    const max = this.max();
    return max > 0 ? Math.min(100, Math.max(0, (this.shown() / max) * 100)) : 0;
  });

  protected drag(event: Event) {
    const value = Number((event.target as HTMLInputElement).value);
    this.held.set(value);
    this.dragging.emit(value);
  }

  protected commit(event: Event) {
    const value = Number((event.target as HTMLInputElement).value);
    this.held.set(null);
    this.dragging.emit(null);
    this.changed.emit(value);
  }
}
