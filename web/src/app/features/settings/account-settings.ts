import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Session } from '../../core/session';
import { SettingsSection } from './settings-section';

@Component({
  selector: 'ob-account-settings',
  imports: [SettingsSection],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .row {
      display: flex;
      align-items: center;
      gap: 18px;
      padding: 20px 0;
      border-top: 1px solid var(--divider);
      border-bottom: 1px solid var(--divider);
    }

    .avatar {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: var(--surface-2);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      font-weight: 700;
      color: var(--text-label);
      text-transform: uppercase;
    }

    .who {
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .name {
      font-size: 15px;
      font-weight: 600;
    }

    .role {
      font-size: 13px;
      color: var(--text-3);
    }
  `,
  template: `
    <ob-settings-section heading="Account">
      @if (session.user(); as user) {
        <div class="row">
          <div class="avatar" aria-hidden="true">{{ user.username.charAt(0) }}</div>
          <div class="who">
            <span class="name">{{ user.username }}</span>
            <span class="role">{{ user.role === 'admin' ? 'Admin' : 'Member' }}</span>
          </div>
          <button class="btn btn-outline btn-sm" type="button" [disabled]="busy()" (click)="signOut()">
            Sign out
          </button>
        </div>
      }
    </ob-settings-section>
  `,
})
export class AccountSettings {
  protected readonly session = inject(Session);
  private readonly router = inject(Router);
  protected readonly busy = signal(false);

  protected async signOut() {
    this.busy.set(true);
    try {
      await this.session.logout();
      await this.router.navigateByUrl('/login');
    } finally {
      this.busy.set(false);
    }
  }
}
