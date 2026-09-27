import type { ActivityState } from '@offbeat/shared';

/** One wording for each state, used by chips, the bottom bar, and Activity. */
export const STATE_LABEL: Record<ActivityState, string> = {
  adding: 'Adding',
  searching: 'Searching',
  queued: 'Queued',
  downloading: 'Downloading',
  importing: 'Importing',
  paused: 'Paused',
  'import-blocked': 'Import blocked',
  failed: 'Failed',
};

/** Blue for things moving along; red for things that need someone. */
export function stateTone(state: ActivityState): 'progress' | 'failed' | 'muted' {
  if (state === 'import-blocked' || state === 'failed') return 'failed';
  if (state === 'paused') return 'muted';
  return 'progress';
}

export function percent(progress: number | null): string {
  return progress === null ? '' : `${Math.round(progress * 100)}%`;
}
