import {Injectable, OnDestroy} from '@angular/core';
import {NetworkService} from '../../model/network/network.service';
import {ContentWrapperUtils, ContentWrapperWithError, PackedContentWrapperWithError} from '../../../../common/entities/ContentWrapper';
import {SubDirectoryDTO,} from '../../../../common/entities/DirectoryDTO';
import {GalleryCacheService} from './cache.gallery.service';
import {BehaviorSubject, EMPTY, from, Observable, Subject, Subscription, timer} from 'rxjs';
import {Config} from '../../../../common/config/public/Config';
import {ShareService} from './share.service';
import {QueryParams} from '../../../../common/QueryParams';
import {ErrorCodes} from '../../../../common/entities/Error';
import {filter, map, startWith, switchMap} from 'rxjs/operators';
import {MediaDTO} from '../../../../common/entities/MediaDTO';
import {FileDTO} from '../../../../common/entities/FileDTO';
import {GalleryService} from './gallery.service';
import {SearchQueryDTO} from '../../../../common/entities/SearchQueryDTO';

@Injectable()
export class ContentLoaderService implements OnDestroy {
  public content: BehaviorSubject<ContentWrapperWithError>;
  public originalContent: Observable<DirectoryContent>;
  private ongoingContentRequest: string = null;
  private lastContentRequest: { type: 'directory' | 'search', value: string } = null;
  private pollingTimerRestart = new Subject<void>();
  private pollingSub: Subscription;
  // syncing-poll: when the backend returns `directory.syncing = true`, we
  // re-fetch the same dir every SYNCING_POLL_MS until the flag clears or
  // SYNCING_POLL_CAP_MS elapses. Keeps the leaflet/map auto-updating after
  // background F3 finishes without forcing the user to refresh manually.
  private syncingPollTimeout: ReturnType<typeof setTimeout> = null;
  private syncingPollDeadlineAt = 0;
  private readonly SYNCING_POLL_MS = 4000;
  private readonly SYNCING_POLL_CAP_MS = 90_000;

  constructor(
    private networkService: NetworkService,
    private galleryCacheService: GalleryCacheService,
    private shareService: ShareService,
    private galleryService: GalleryService
  ) {
    this.content = new BehaviorSubject<ContentWrapperWithError>(
      {} as ContentWrapperWithError
    );
    this.originalContent = this.content.pipe(
      map((c) => (c?.directory ? c?.directory : c?.searchResult))
    );
    this.setupAutoUpdate();
  }

  ngOnDestroy(): void {
    this.unSubPolling();
    this.cancelSyncingPoll();
  }

  private cancelSyncingPoll(): void {
    if (this.syncingPollTimeout) {
      clearTimeout(this.syncingPollTimeout);
      this.syncingPollTimeout = null;
    }
    this.syncingPollDeadlineAt = 0;
  }

  private scheduleSyncingPollIfNeeded(cw: PackedContentWrapperWithError | null): void {
    const syncing = (cw as any)?.directory?.syncing === true;
    if (!syncing) {
      this.cancelSyncingPoll();
      return;
    }
    const now = Date.now();
    if (this.syncingPollDeadlineAt === 0) {
      this.syncingPollDeadlineAt = now + this.SYNCING_POLL_CAP_MS;
    }
    if (now >= this.syncingPollDeadlineAt) {
      // Gave up — leave the banner showing (DTO still has syncing=true). A
      // manual refresh will reset the cap.
      return;
    }
    if (this.syncingPollTimeout) return;
    this.syncingPollTimeout = setTimeout(() => {
      this.syncingPollTimeout = null;
      // Only re-fetch if we're still on the same directory.
      if (this.lastContentRequest?.type === 'directory') {
        this.loadDirectory(this.lastContentRequest.value, true).catch(console.error);
      }
    }, this.SYNCING_POLL_MS);
  }

  setupAutoUpdate() {
    this.pollingSub = this.galleryService.autoPollIntervalS.pipe(
      switchMap(interval => {
        if (!interval) {
          return EMPTY; // stop polling
        }

        // Start polling or restart when pollingTimerRestart emits
        return this.pollingTimerRestart.pipe(
          startWith(void 0),
          switchMap(() =>
            timer(
              interval * 1000,
              interval * 1000
            ).pipe(
              filter(() => this.ongoingContentRequest === null),
              switchMap(i => from(this.reloadCurrentContent()))
            )
          )
        );
      })
    ).subscribe({
      error: err => console.error(err)
    });
  }

  setContent(content: ContentWrapperWithError): void {
    if (ContentWrapperUtils.equals(this.content.value, content)) {
      return;
    }
    this.content.next(content);
  }

  public async loadDirectory(directoryName: string, forceReload = false): Promise<void> {

    // load from cache
    const cachedCw = this.galleryCacheService.getDirectory(directoryName);

    // If this is a fresh navigation (different dir than the one we are polling
    // for), drop any in-flight syncing-poll for the previous dir.
    if (this.lastContentRequest?.value !== directoryName) {
      this.cancelSyncingPoll();
    }

    this.setContent(ContentWrapperUtils.unpack(cachedCw));
    this.ongoingContentRequest = directoryName;
    this.lastContentRequest = {type: 'directory', value: directoryName};

    // prepare server request
    const params: { [key: string]: unknown } = {};
    if (Config.Sharing.enabled === true) {
      if (this.shareService.isSharing()) {
        params[QueryParams.gallery.sharingKey_query] =
          this.shareService.getSharingKey();
      }
    }
    let cw :PackedContentWrapperWithError = null;

    try {
      if (
        !forceReload &&
        cachedCw?.directory &&
        cachedCw?.directory.lastModified &&
        cachedCw?.directory.lastScanned &&
        !cachedCw?.directory.isPartial
      ) {
        params[QueryParams.gallery.knownLastModified] =
          cachedCw?.directory.lastModified;
        params[QueryParams.gallery.knownLastScanned] =
          cachedCw?.directory.lastScanned;
      }

      cw = await this.networkService.getJson<PackedContentWrapperWithError>(
        '/gallery/content/' + encodeURIComponent(directoryName),
        params
      );
    } catch (e) {
      console.error(e);
    }
    if (this.ongoingContentRequest !== directoryName) {
      return;
    }
    this.ongoingContentRequest = null;
    this.pollingTimerRestart.next();

    if (!cw || cw.notModified === true) {
      return;
    }

    if (!!cw?.directory) {
      this.galleryCacheService.setDirectory(cw); // save it before adding references
    }
    this.setContent(ContentWrapperUtils.unpack(cw));
    this.scheduleSyncingPollIfNeeded(cw);
  }

  public async search(query: SearchQueryDTO, forceReload = false): Promise<void> {
    const queryStr = JSON.stringify(query);
    this.ongoingContentRequest = queryStr;
    this.lastContentRequest = {type: 'search', value: queryStr};

    if (!forceReload) {
      this.setContent({} as PackedContentWrapperWithError); // don't empty the page when its just a reload
    }

    let cw = this.galleryCacheService.getSearch(query);
    if (forceReload || (!cw || cw.searchResult == null)) {
      try {
        cw = await this.networkService.getJson<PackedContentWrapperWithError>('/search/' + encodeURIComponent(queryStr));
        this.galleryCacheService.setSearch(cw);
      } catch (e) {
        cw = cw || {
          directory: null,
          searchResult: null
        } as PackedContentWrapperWithError;
        if (e.code === ErrorCodes.LocationLookUp_ERROR) {
          cw.error = $localize`Cannot find location` + ': ' + e.message;
        } else {
          cw.error = $localize`Unknown server error` + ': ' + e.message;
        }
      }
    }

    if (this.ongoingContentRequest !== queryStr) {
      return;
    }
    this.ongoingContentRequest = null;
    this.pollingTimerRestart.next();

    this.setContent(ContentWrapperUtils.unpack(cw));
  }

  isSearchResult(): boolean {
    return !!this.content.value.searchResult;
  }

  public async reloadCurrentContent(): Promise<void> {
    if (!this.lastContentRequest) {
      return;
    }

    if (this.lastContentRequest.type === 'directory') {
      await this.loadDirectory(this.lastContentRequest.value, true);
    } else if (this.lastContentRequest.type === 'search') {
      await this.search(JSON.parse(this.lastContentRequest.value), true);
    }
  }

  private unSubPolling() {

    if (this.pollingSub) {
      this.pollingSub.unsubscribe();
      this.pollingSub = null;
    }
  }
}


export interface DirectoryContent {
  directories: SubDirectoryDTO[];
  media: MediaDTO[];
  metaFile: FileDTO[];
}
