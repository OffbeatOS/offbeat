import type { ActivityItem, ActivityState } from '@offbeat/shared';
import type { LidarrQueueItem } from '../integrations/lidarr/client.js';

/** Lidarr's two layers of status (client status, then tracked download state) as one plain state. */
export function queueState(item: Pick<LidarrQueueItem, 'status' | 'trackedDownloadState'>): ActivityState {
  const status = (item.status ?? '').toLowerCase();
  const tracked = (item.trackedDownloadState ?? '').toLowerCase();
  if (tracked === 'importblocked' || tracked === 'importfailed') return 'import-blocked';
  if (tracked === 'downloadfailed' || tracked === 'downloadfailedpending' || status === 'failed') return 'failed';
  if (tracked === 'importpending' || tracked === 'importing' || status === 'completed') return 'importing';
  if (status === 'paused') return 'paused';
  if (status === 'downloading') return 'downloading';
  return 'queued';
}

/** Lidarr's per-file messages, deduplicated, without the file names. */
export function queueMessages(item: Pick<LidarrQueueItem, 'statusMessages' | 'errorMessage'>): string[] {
  const seen = new Set<string>();
  if (item.errorMessage) seen.add(item.errorMessage.trim());
  for (const group of item.statusMessages ?? []) {
    const messages = (group.messages ?? []).filter(Boolean);
    // A group with messages is "<file name>: <problems>"; one without is a summary line.
    if (messages.length) messages.forEach((m) => seen.add(m.trim()));
    else if (group.title) seen.add(group.title.trim());
  }
  return [...seen].filter(Boolean);
}

/** Why an import was blocked, in words someone new to Lidarr can act on. */
export function importBlockedReason(messages: string[]): string {
  const text = messages.join(' ').toLowerCase();
  if (text.includes('match is not close enough') || text.includes('worst track match')) {
    return 'Lidarr downloaded this, but the files did not match the album closely enough to import. Check the release in Lidarr and import it manually, or retry to try a different release.';
  }
  if (text.includes('missing tracks') || text.includes('not imported or missing')) {
    return 'Lidarr downloaded this, but tracks the album expects are missing from the release. Retry to try a different release, or import what is there manually in Lidarr.';
  }
  if (text.includes('no files found') || text.includes('no audio files')) {
    return 'Lidarr downloaded this, but found no audio files in it. Retry to try a different release.';
  }
  if (text.includes('permission') || text.includes('access')) {
    return 'Lidarr downloaded this, but could not access the files to import them. Check permissions on the download and music folders.';
  }
  return 'Lidarr downloaded this, but could not import it. Open Lidarr to see why.';
}

/**
 * Why a download has sat in "importing" for over an hour, from the rejections
 * in Lidarr's Manual Import preview (empty when it gave none, or while they
 * are still being fetched).
 */
export function importStuckReason(rejections: string[]): string {
  const text = rejections.join(' ').toLowerCase();
  const lead = 'Lidarr downloaded this over an hour ago but will not import it on its own';
  const fix = 'Use Manual Import in Lidarr to check the tracks and import them.';
  const match = text.match(/match is not close enough: ([\d.]+) ?% vs ([\d.]+) ?%/);
  if (match) {
    const got = Math.round(Number(match[1]));
    const needed = Math.round(Number(match[2]));
    return `${lead}: the files match the album only ${got}%, and Lidarr needs ${needed}%. This is often a different edition of the album. ${fix}`;
  }
  if (text.includes('not an upgrade') || text.includes('not a custom format upgrade')) {
    return `${lead}: you already have these tracks at the same or better quality. Remove the download in Lidarr, or use Manual Import to replace them anyway.`;
  }
  if (text.includes('unmatched tracks') || text.includes('missing tracks')) {
    return `${lead}: some files do not match any track on the album. ${fix}`;
  }
  if (text.includes('no files found') || text.includes('no audio files')) {
    return `${lead}: it found no audio files in the download. Retry to try a different release.`;
  }
  if (rejections.length) return `${lead}. ${fix}`;
  return `${lead}, and it has not said why. ${fix}`;
}

export function formatTimeLeft(timeleft: string | null | undefined): string {
  // Lidarr sends "hh:mm:ss" or "d.hh:mm:ss".
  const match = timeleft?.match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+)/);
  if (!match) return '';
  const minutes = Number(match[1] ?? 0) * 1440 + Number(match[2]) * 60 + Number(match[3]);
  if (minutes === 0) return 'less than a minute left';
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.round(minutes / 60);
  return `about ${hours} ${hours === 1 ? 'hour' : 'hours'} left`;
}

/** The state-specific parts of an activity item for a queue entry. */
export function describeQueueItem(
  item: LidarrQueueItem,
): Pick<ActivityItem, 'state' | 'progress' | 'detail' | 'reason' | 'messages' | 'canRetry' | 'canCancel'> {
  const state = queueState(item);
  const messages = queueMessages(item);
  const size = item.size ?? 0;
  const progress = size > 0 ? Math.min(1, Math.max(0, (size - (item.sizeleft ?? 0)) / size)) : null;
  switch (state) {
    case 'downloading': {
      const pct = progress === null ? '' : `${Math.round(progress * 100)}%`;
      const left = formatTimeLeft(item.timeleft);
      return {
        state,
        progress,
        detail: [pct, left].filter(Boolean).join(', ') || 'Downloading',
        reason: null,
        messages: [],
        canRetry: false,
        canCancel: true,
      };
    }
    case 'import-blocked':
      return {
        state,
        progress: null,
        detail: 'Downloaded, not imported',
        reason: importBlockedReason(messages),
        messages,
        canRetry: true,
        canCancel: false,
      };
    case 'failed':
      return {
        state,
        progress: null,
        detail: 'Download failed',
        reason: messages[0] ?? 'The download failed in the download client.',
        messages,
        canRetry: true,
        canCancel: false,
      };
    case 'importing':
      return { state, progress: 1, detail: 'Importing into your library', reason: null, messages: [], canRetry: false, canCancel: false };
    case 'paused':
      return { state, progress, detail: 'Paused in the download client', reason: null, messages: [], canRetry: false, canCancel: true };
    default:
      return { state, progress: null, detail: 'Waiting in the download client', reason: null, messages: [], canRetry: false, canCancel: true };
  }
}

/** States that change on their own, so the poller should check often. */
export const ACTIVE_STATES: ReadonlySet<ActivityState> = new Set(['adding', 'searching', 'queued', 'downloading', 'importing']);

/** States that need someone to act. */
export const ATTENTION_STATES: ReadonlySet<ActivityState> = new Set(['import-blocked', 'import-stuck', 'failed']);
