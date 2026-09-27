import { ChangeDetectionStrategy, Component, forwardRef, input, signal } from '@angular/core';
import { type ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

/** On/off switch in the accent color, usable with reactive forms. */
@Component({
  selector: 'ob-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => Toggle), multi: true }],
  styles: `
    button {
      display: flex;
      align-items: flex-start;
      gap: 14px;
      width: 100%;
      padding: 0;
      border: 0;
      background: none;
      color: inherit;
      text-align: left;
    }

    .track {
      position: relative;
      flex-shrink: 0;
      width: 40px;
      height: 24px;
      border-radius: 12px;
      background: var(--track);
      transition: background-color 150ms ease;
    }

    .knob {
      position: absolute;
      top: 3px;
      left: 3px;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: var(--text);
      transition: transform 150ms ease;
    }

    [aria-checked='true'] .track {
      background: var(--accent);
    }

    [aria-checked='true'] .knob {
      transform: translateX(16px);
    }

    .text {
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding-top: 2px;
    }

    .label {
      font-size: 14px;
      font-weight: 500;
    }

    .hint {
      font-size: 13px;
      color: var(--text-3);
      line-height: 1.4;
    }

    button:disabled {
      opacity: 0.5;
      cursor: default;
    }
  `,
  template: `
    <button type="button" role="switch" [attr.aria-checked]="value()" [disabled]="disabled()" (click)="flip()">
      <span class="track"><span class="knob"></span></span>
      <span class="text">
        <span class="label">{{ label() }}</span>
        @if (hint()) {
          <span class="hint">{{ hint() }}</span>
        }
      </span>
    </button>
  `,
})
export class Toggle implements ControlValueAccessor {
  readonly label = input.required<string>();
  readonly hint = input<string>();

  protected readonly value = signal(false);
  protected readonly disabled = signal(false);
  private onChange: (value: boolean) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  protected flip() {
    this.value.update((v) => !v);
    this.onChange(this.value());
    this.onTouched();
  }

  writeValue(value: boolean): void {
    this.value.set(!!value);
  }
  registerOnChange(fn: (value: boolean) => void): void {
    this.onChange = fn;
  }
  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }
  setDisabledState(disabled: boolean): void {
    this.disabled.set(disabled);
  }
}
