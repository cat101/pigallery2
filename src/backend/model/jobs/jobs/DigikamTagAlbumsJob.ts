import {ObjectManagers} from '../../ObjectManagers';
import {DefaultsJobs} from '../../../../common/entities/job/JobDTO';
import {Job} from './Job';
import {DynamicConfig} from '../../../../common/entities/DynamicConfig';
import {SQLConnection} from '../../database/SQLConnection';
import {MediaEntity} from '../../database/enitites/MediaEntity';
import {SavedSearchEntity} from '../../database/enitites/album/SavedSearchEntity';
import {AlbumManager} from '../../database/AlbumManager';
import {MetadataLoader} from '../../fileaccess/MetadataLoader';
import {TextSearch} from '../../../../common/entities/SearchQueryDTO';
import {Logger} from '../../../Logger';

// (Re)generate saved-search albums from digiKam tag-tree paths that were
// indexed into media.metadata.keywords by MetadataLoader.mapDigikamTagAlbums.
// IndexingManager already creates each album incrementally as its folder is
// indexed; this job does a full sweep (catch-up after enabling the feature on
// an already-indexed library) and, crucially, prunes albums whose tag no
// longer exists. Self-healing — purely derived from the index.
export class DigikamTagAlbumsJob extends Job {
  public readonly Name = DefaultsJobs[DefaultsJobs['Digikam Tag Albums']];
  public readonly ConfigTemplate: DynamicConfig[] = null;
  protected readonly IsInstant = true;

  get LOG_TAG(): string {
    return '[DigikamTagAlbumsJob]';
  }

  public get Supported(): boolean {
    return true;
  }

  protected async init(): Promise<void> {
    // abstract function
  }

  protected async step(): Promise<boolean> {
    this.Progress.Left = 1;
    const prefixes = MetadataLoader.digikamAlbumPrefixes();
    if (prefixes.length === 0) {
      Logger.info(this.LOG_TAG,
        'digiKam tag-tree albums are disabled or no prefixes set; nothing to do.');
      this.Progress.Processed++;
      return false;
    }

    const connection = await SQLConnection.getConnection();
    const albumManager = ObjectManagers.getInstance().AlbumManager;

    // Distinct keyword-sets, split to tokens, keep those under a prefix root.
    const wantedPaths = new Set<string>();
    const rows = await connection.getRepository(MediaEntity)
      .createQueryBuilder('media')
      .select('DISTINCT(media.metadata.keywords)')
      .getRawMany();
    for (const r of rows) {
      for (const kw of ((r.metadataKeywords as string) || '').split(',')) {
        if (kw.indexOf('/') !== -1
          && prefixes.indexOf(AlbumManager.digikamTagRoot(kw)) !== -1) {
          wantedPaths.add(kw);
        }
      }
    }

    // Create any missing albums.
    for (const path of wantedPaths) {
      await albumManager.addDigikamTagAlbum(path);
    }

    // Prune albums we generated whose tag no longer exists.
    const albums = await connection.getRepository(SavedSearchEntity).find();
    let pruned = 0;
    for (const a of albums) {
      if (AlbumManager.isDigikamTagAlbum(a, prefixes)
        && !wantedPaths.has((a.searchQuery as TextSearch).value)) {
        await albumManager.deleteAlbum(a.id);
        pruned++;
      }
    }

    Logger.info(this.LOG_TAG,
      `digiKam tag-tree albums: ${wantedPaths.size} tag(s) present, ${pruned} stale album(s) pruned.`);
    this.Progress.Processed++;
    return false;
  }
}
