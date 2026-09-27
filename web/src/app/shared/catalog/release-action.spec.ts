import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ActivityItem, ActivitySnapshot, ReleaseSummary } from '@offbeat/shared';
import { ActivityStore } from '../../core/activity-store';
import { ReleaseAction } from './release-action';

const MBID = 'd035d4d8-0344-3b64-8b70-f6d74860fbea';

const release = (status: ReleaseSummary['status']): ReleaseSummary => ({
  mbid: MBID,
  title: 'Life in General',
  type: 'Album',
  year: 1995,
  coverUrl: null,
  artistMbid: '33333333-0000-4000-8000-000000000000',
  artistName: 'MxPx',
  status,
});

const importing: ActivityItem = {
  id: 'queue:1',
  state: 'importing',
  albumMbid: MBID,
  albumTitle: 'Life in General',
  artistMbid: null,
  artistName: 'MxPx',
  coverUrl: null,
  progress: 1,
  detail: 'Importing into your library',
  reason: null,
  messages: [],
  source: 'Added in Lidarr',
  canRetry: false,
  canCancel: false,
  lidarrLink: null,
};

const snapshot = (inProgress: ActivityItem[]): ActivitySnapshot => ({
  attention: [],
  inProgress,
  completed: [],
  updatedAt: new Date().toISOString(),
  error: null,
});

async function settle(fixture: { whenStable(): Promise<unknown>; detectChanges(): void }) {
  await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('ReleaseAction', () => {
  it('asks for the new status once an import leaves Activity, instead of showing the stale one', async () => {
    TestBed.configureTestingModule({
      imports: [ReleaseAction],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const store = TestBed.inject(ActivityStore);
    const http = TestBed.inject(HttpTestingController);
    store.snapshot.set(snapshot([importing]));

    const fixture = TestBed.createComponent(ReleaseAction);
    fixture.componentRef.setInput('release', release({ kind: 'requested' }));
    await settle(fixture);
    const text = () => (fixture.nativeElement as HTMLElement).textContent?.replace(/\s+/g, ' ').trim();
    expect(text()).toContain('Importing');

    // Lidarr finished: the item leaves the stream. The page's own data still says Wanted.
    store.snapshot.set(snapshot([]));
    await settle(fixture);
    http.expectOne(`api/v1/albums/${MBID}`).flush({ status: { kind: 'in-library' } });
    await settle(fixture);
    expect(text()).toContain('In Library');
    expect(text()).not.toContain('Wanted');
    http.verify();
  });

  it('lets fresh data from the page replace its own status', async () => {
    TestBed.configureTestingModule({
      imports: [ReleaseAction],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const store = TestBed.inject(ActivityStore);
    const http = TestBed.inject(HttpTestingController);
    store.snapshot.set(snapshot([importing]));
    const fixture = TestBed.createComponent(ReleaseAction);
    fixture.componentRef.setInput('release', release({ kind: 'requested' }));
    await settle(fixture);
    store.snapshot.set(snapshot([]));
    await settle(fixture);
    http.expectOne(`api/v1/albums/${MBID}`).flush({ status: { kind: 'partial', missingTracks: 2 } });
    await settle(fixture);

    fixture.componentRef.setInput('release', release({ kind: 'in-library' }));
    await settle(fixture);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('In Library');
  });
});
