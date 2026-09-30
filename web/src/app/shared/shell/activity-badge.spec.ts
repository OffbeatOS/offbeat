import type { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { ActivityItem } from '@offbeat/shared';
import { ActivityStore } from '../../core/activity-store';
import { Sidebar } from './sidebar';
import { TabBar } from './tab-bar';

const downloading = (n: number): ActivityItem =>
  ({
    id: `queue:${n}`,
    state: 'downloading',
    albumMbid: null,
    albumTitle: `Album ${n}`,
    artistMbid: null,
    artistName: 'Burial',
    coverUrl: null,
    progress: 0.5,
    detail: '',
  }) as ActivityItem;

/** Download activity on the navigation (Playing and MobilePlaying mockups), since the bar may be the player. */
describe('download activity on the navigation', () => {
  function render(component: Type<unknown>, count: number) {
    TestBed.configureTestingModule({ imports: [component], providers: [provideRouter([])] });
    TestBed.inject(ActivityStore).snapshot.set({
      attention: [],
      inProgress: Array.from({ length: count }, (_, i) => downloading(i)),
      completed: [],
      updatedAt: null,
      error: null,
    });
    const fixture = TestBed.createComponent(component);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('counts downloads in a blue badge on Activity in the sidebar', () => {
    const el = render(Sidebar, 2);
    const activity = [...el.querySelectorAll('ob-nav-item')].find((item) => item.textContent?.includes('Activity'))!;
    expect(activity.querySelector('.badge')?.textContent?.trim()).toBe('2');
    expect(activity.querySelector('.badge')?.getAttribute('aria-label')).toBe('2 downloads in progress');
    expect(el.querySelectorAll('.badge')).toHaveLength(1);
  });

  it('shows no badge when nothing is downloading', () => {
    expect(render(Sidebar, 0).querySelector('.badge')).toBeNull();
  });

  it('puts a blue dot on the phone Activity tab', () => {
    const el = render(TabBar, 1);
    const tab = [...el.querySelectorAll('a')].find((a) => a.textContent?.includes('Activity'))!;
    expect(tab.querySelector('.dot')).not.toBeNull();
    expect(el.querySelectorAll('.dot')).toHaveLength(1);
  });
});
