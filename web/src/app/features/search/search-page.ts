import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  type OnInit,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { ApiErrorBody, ArtistDetail, SearchResponse } from '@offbeat/shared';
import { Subject, catchError, debounceTime, distinctUntilChanged, map, of, startWith, switchMap } from 'rxjs';
import { ApiError, Api } from '../../core/api';
import { ArtistCircle } from '../../shared/catalog/artist-circle';
import { releaseMeta } from '../../shared/catalog/album-card';
import { Cover } from '../../shared/catalog/cover';
import { ReleaseAction } from '../../shared/catalog/release-action';
import { EmptyState } from '../../shared/empty-state/empty-state';
import { Icon } from '../../shared/icon/icon';

type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; result: SearchResponse }
  | { kind: 'error'; message: string };

const DEBOUNCE_MS = 300;

/**
 * Search mockup. Typing is debounced, and each new query cancels the request
 * still in flight (switchMap unsubscribes, which aborts the fetch). The query
 * lives in the URL so back and forward work.
 */
@Component({
  selector: 'ob-search-page',
  imports: [RouterLink, ArtistCircle, Cover, ReleaseAction, EmptyState, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './search-page.scss',
  templateUrl: './search-page.html',
})
export class SearchPage implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly input = viewChild.required<ElementRef<HTMLInputElement>>('box');

  private readonly queries = new Subject<string>();
  protected readonly query = signal('');
  protected readonly state = signal<SearchState>({ kind: 'idle' });
  /** Last results, kept on screen (dimmed) while the next query loads. */
  protected readonly last = signal<SearchResponse | null>(null);
  protected readonly addingArtist = signal(false);
  protected readonly addError = signal('');

  protected readonly result = computed(() => {
    const state = this.state();
    return state.kind === 'done' ? state.result : this.last();
  });
  protected readonly errorMessage = computed(() => {
    const state = this.state();
    return state.kind === 'error' ? state.message : '';
  });
  protected readonly meta = releaseMeta;

  ngOnInit() {
    const initial = this.route.snapshot.queryParamMap.get('q') ?? '';
    this.query.set(initial);
    this.input().nativeElement.focus();

    this.queries
      .pipe(
        startWith(initial),
        map((q) => q.trim()),
        debounceTime(DEBOUNCE_MS),
        distinctUntilChanged(),
        switchMap((q) => {
          void this.router.navigate([], { queryParams: { q: q || null }, replaceUrl: true });
          if (q.length < 2) return of<SearchState>({ kind: 'idle' });
          this.state.set({ kind: 'loading' });
          return this.http.get<SearchResponse>('api/v1/search', { params: { q } }).pipe(
            map((result): SearchState => ({ kind: 'done', result })),
            catchError((error: unknown) => of<SearchState>({ kind: 'error', message: messageOf(error) })),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((state) => {
        this.state.set(state);
        if (state.kind === 'done') this.last.set(state.result);
        if (state.kind === 'idle') this.last.set(null);
      });
  }

  protected onInput(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.query.set(value);
    this.queries.next(value);
  }

  /** Adds the top result artist, then reflects its new status in place. */
  protected async addTopArtist() {
    const top = this.result()?.top;
    if (top?.kind !== 'artist' || this.addingArtist()) return;
    this.addingArtist.set(true);
    this.addError.set('');
    try {
      const detail = await this.api.post<ArtistDetail>(`artists/${top.artist.mbid}`);
      const current = this.result();
      if (current?.top?.kind === 'artist') {
        this.last.set({ ...current, top: { ...current.top, artist: { ...current.top.artist, inLibrary: detail.inLibrary } } });
        this.state.set({ kind: 'done', result: this.last()! });
      }
    } catch (error) {
      this.addError.set(error instanceof ApiError ? error.message : 'Could not add this artist');
    } finally {
      this.addingArtist.set(false);
    }
  }
}

function messageOf(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 0) return 'Could not reach the Offbeat server.';
    return (error.error as Partial<ApiErrorBody> | null)?.message ?? 'Search failed';
  }
  return 'Search failed';
}
