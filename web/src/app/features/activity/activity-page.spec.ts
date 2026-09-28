import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { ActivityItem, ActivitySnapshot } from '@offbeat/shared';
import { ActivityStore } from '../../core/activity-store';
import { BottomBar } from '../../shared/shell/bottom-bar';
import { ActivityPage } from './activity-page';
import { ADMIN, MEMBER, signIn } from '../../testing/users';

function item(extra: Partial<ActivityItem>): ActivityItem {
  return {
    id: 'queue:1',
    state: 'downloading',
    albumMbid: '11111111-0000-4000-8000-000000000001',
    albumTitle: 'Antidawn',
    artistMbid: null,
    artistName: 'Burial',
    coverUrl: null,
    progress: 0.64,
    detail: '64%, about 3 min left',
    reason: null,
    messages: [],
    source: 'requested by sam',
    canRetry: false,
    canCancel: true,
    lidarrLink: null,
    ...extra,
  };
}

const SNAPSHOT: ActivitySnapshot = {
  attention: [
    item({
      id: 'queue:2',
      state: 'import-blocked',
      albumTitle: 'Rival Dealer',
      progress: null,
      detail: 'Downloaded, not imported',
      reason: 'Lidarr downloaded this, but the files did not match the album closely enough to import.',
      messages: ['Album match is not close enough: 73.4 % vs 80 %'],
      source: 'Added in Lidarr',
      canRetry: true,
      canCancel: false,
      lidarrLink: 'http://lidarr:8686/activity/queue',
    }),
  ],
  inProgress: [item({}), item({ id: 'search:9', state: 'searching', albumTitle: "Tomorrow's Harvest", progress: null, detail: 'Checking indexers', canCancel: false })],
  completed: [
    { id: 'history:1', albumMbid: null, albumTitle: 'Untrue', artistMbid: null, artistName: 'Burial', coverUrl: null, date: new Date().toISOString(), source: 'requested by sam' },
  ],
  updatedAt: new Date().toISOString(),
  error: null,
};

async function render<T>(component: Type<T>, snapshot: ActivitySnapshot = SNAPSHOT, user = ADMIN) {
  TestBed.configureTestingModule({
    imports: [component],
    providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
  });
  signIn(user);
  TestBed.inject(ActivityStore).snapshot.set(snapshot);
  const fixture = TestBed.createComponent(component);
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('ActivityPage', () => {
  it('shows what needs attention, what is moving, and what finished', async () => {
    const el = await render(ActivityPage);
    expect([...el.querySelectorAll('h2')].map((h) => h.textContent?.trim())).toEqual(['Needs Attention', 'In Progress', 'Completed']);

    const card = el.querySelector('.card')!;
    expect(card.querySelector('.state')?.textContent).toContain('Import blocked');
    expect(card.querySelector('.reason')?.textContent).toContain('did not match the album closely enough');
    expect(card.querySelector('.sub')?.textContent).toBe('Burial, Added in Lidarr');
    expect([...card.querySelectorAll('.actions a, .actions button')].map((b) => b.textContent?.trim())).toEqual(['Open in Lidarr', 'Retry']);

    const rows = [...el.querySelectorAll('.rows')[0]!.querySelectorAll('.row')];
    expect(rows.map((r) => r.querySelector('.state')?.textContent?.trim())).toEqual(['Downloading', 'Searching']);
    expect(rows[0]?.querySelector('.sub')?.textContent).toBe('Burial, requested by sam');
    expect(el.querySelector('.imported')?.textContent).toContain('Imported to library');
  });

  it('flags a stuck import and links to Manual Import in Lidarr', async () => {
    const stuck = item({
      id: 'queue:3',
      state: 'import-stuck',
      albumTitle: 'So Long and Thanks for All the Shoes',
      progress: null,
      detail: 'Downloaded, not imported',
      reason: 'Lidarr downloaded this over an hour ago but will not import it on its own: the files match the album only 74%, and Lidarr needs 80%.',
      messages: ['Album match is not close enough: 74.4 % vs 80 %'],
      canRetry: true,
      canCancel: false,
      lidarrLink: 'http://lidarr:8686/activity/queue',
    });
    const el = await render(ActivityPage, { ...SNAPSHOT, attention: [stuck] });
    const card = el.querySelector('.card')!;
    expect(card.querySelector('.state')?.textContent).toContain('Import stuck');
    expect(card.querySelector('.reason')?.textContent).toContain('only 74%, and Lidarr needs 80%');
    const link = card.querySelector<HTMLAnchorElement>('.actions a')!;
    expect(link.textContent?.trim()).toBe('Manual Import in Lidarr');
    expect(link.getAttribute('href')).toBe('http://lidarr:8686/activity/queue');
  });

  it('offers a Member without permissions neither Retry nor Cancel', async () => {
    const el = await render(ActivityPage, SNAPSHOT, MEMBER);
    expect([...el.querySelectorAll('.card .actions button')].map((b) => b.textContent?.trim())).toEqual([]);
    expect(el.querySelector('.card .actions a')?.textContent?.trim()).toBe('Open in Lidarr');
    expect(el.querySelector('.row .cancel')).toBeNull();
  });

  it('asks before removing a download', async () => {
    const el = await render(ActivityPage);
    el.querySelector<HTMLButtonElement>('.cancel')!.click();
    TestBed.tick();
    expect(el.querySelector('.confirm')?.textContent).toBe('Remove download');
    expect(el.querySelector('.cancel')).toBeNull();
  });
});

describe('BottomBar', () => {
  it('shows the current download, the queue, and what needs attention', async () => {
    const el = await render(BottomBar);
    expect(el.querySelector('.title')?.textContent).toBe('Antidawn');
    expect(el.querySelector('.value')?.textContent).toBe('64%');
    expect(el.querySelector('.caption')?.textContent).toBe('Downloading, 1 more in queue');
    expect(el.querySelector('.attention')?.textContent).toContain('1 needs attention');
  });

  it('says so when nothing is happening', async () => {
    TestBed.configureTestingModule({ imports: [BottomBar], providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    const fixture = TestBed.createComponent(BottomBar);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.idle')?.textContent).toBe('No downloads in progress');
  });
});
