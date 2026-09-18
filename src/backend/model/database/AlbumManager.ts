import {SQLConnection} from './SQLConnection';
import {AlbumBaseEntity} from './enitites/album/AlbumBaseEntity';
import {ObjectManagers} from '../ObjectManagers';
import {
  SearchQueryDTO,
  SearchQueryTypes,
  TextSearch,
  TextSearchQueryMatchTypes,
} from '../../../common/entities/SearchQueryDTO';
import {SavedSearchEntity} from './enitites/album/SavedSearchEntity';
import {Logger} from '../../Logger';
import {SessionContext} from '../SessionContext';
import {ProjectedAlbumCacheEntity} from './enitites/album/ProjectedAlbumCacheEntity';
import {ProjectionAwareManager} from './ProjectionAwareManager';
import {NotificationManager} from '../NotifocationManager';
import {Job} from '../jobs/jobs/Job';

const LOG_TAG = '[AlbumManager]';

export class AlbumManager extends ProjectionAwareManager<AlbumBaseEntity> {

  // --- digiKam tag-tree albums (see DigikamTagAlbumsJob / IndexingManager) ---
  // The single source of truth for how a tag path maps to an album, so that
  // incremental creation (indexing), bulk creation and pruning (the job) all
  // agree on the album's name and query shape.

  // Leading segment of a path, e.g. "Albums/Trips/Cuba" -> "Albums".
  public static digikamTagRoot(path: string): string {
    return path.split('/', 1)[0];
  }

  // Display name = path with the prefix root stripped: "Trips/Cuba".
  public static digikamTagAlbumName(path: string): string {
    return path.substring(path.indexOf('/') + 1);
  }

  // Exact keyword match on the full prefixed path.
  public static digikamTagAlbumQuery(path: string): TextSearch {
    return {
      type: SearchQueryTypes.keyword,
      matchType: TextSearchQueryMatchTypes.exact_match,
      value: path,
    };
  }

  // True if an album looks like one we generated from a tag under `prefixes`:
  // an exact keyword query whose value sits under a prefix and whose name is
  // the stripped suffix. Used by the job to prune only its own albums.
  public static isDigikamTagAlbum(a: SavedSearchEntity, prefixes: string[]): boolean {
    const q = a.searchQuery as TextSearch;
    return q?.type === SearchQueryTypes.keyword
      && q.matchType === TextSearchQueryMatchTypes.exact_match
      && typeof q.value === 'string'
      && prefixes.indexOf(AlbumManager.digikamTagRoot(q.value)) !== -1
      && a.name === AlbumManager.digikamTagAlbumName(q.value);
  }

  public async addDigikamTagAlbum(fullPath: string): Promise<void> {
    await this.addIfNotExistSavedSearch(
      AlbumManager.digikamTagAlbumName(fullPath),
      AlbumManager.digikamTagAlbumQuery(fullPath),
      false
    );
  }

  // Delete all generated tag-tree albums. Called on Gallery Reset so they don't
  // linger as orphans pointing at a wiped index — they regenerate on re-index.
  // Manual saved searches (any album that isn't shaped like a tag album) are
  // left intact.
  public async deleteDigikamTagAlbums(prefixes: string[]): Promise<void> {
    if (prefixes.length === 0) {
      return;
    }
    const connection = await SQLConnection.getConnection();
    for (const a of await connection.getRepository(SavedSearchEntity).find()) {
      if (AlbumManager.isDigikamTagAlbum(a, prefixes)) {
        await this.deleteAlbum(a.id);
      }
    }
  }

  public async addIfNotExistSavedSearch(
    name: string,
    searchQuery: SearchQueryDTO,
    lockedAlbum: boolean
  ): Promise<void> {
    const connection = await SQLConnection.getConnection();
    const album = await connection
      .getRepository(SavedSearchEntity)
      .findOneBy({name, searchQuery});
    if (album) {
      return;
    }
    await this.addSavedSearch(name, searchQuery, lockedAlbum);
    this.resetMemoryCache();
  }

  public async addSavedSearch(
    name: string,
    searchQuery: SearchQueryDTO,
    lockedAlbum?: boolean
  ): Promise<void> {
    const connection = await SQLConnection.getConnection();
    await connection
      .getRepository(SavedSearchEntity)
      .save({name, searchQuery, locked: lockedAlbum});
    this.resetMemoryCache();
  }

  public async deleteAlbum(id: number): Promise<void> {
    const connection = await SQLConnection.getConnection();
    const albumCount = await connection
      .getRepository(AlbumBaseEntity)
      .countBy({id, locked: false});

    if (albumCount == 0) {
      throw new Error(`Could not delete album, id: ${id}. Album id is not found or the album is locked.`);
    }

    if (albumCount > 1) {
      throw new Error(`Could not delete album, id: ${id}. DB is inconsistent. More than one album is found with the given id.`);
    }

    await connection
      .getRepository(AlbumBaseEntity)
      .delete({id, locked: false});

    this.resetMemoryCache();
  }

  async deleteAll() {
    const connection = await SQLConnection.getConnection();
    await connection
      .getRepository(AlbumBaseEntity)
      .createQueryBuilder('album')
      .delete()
      .execute();
    this.resetMemoryCache();
  }

  protected async loadEntities(session: SessionContext): Promise<AlbumBaseEntity[]> {
    await this.updateAlbums(session);
    const connection = await SQLConnection.getConnection();

    // Return albums with projected cache data
    const result = await connection
      .getRepository(AlbumBaseEntity)
      .createQueryBuilder('album')
      .leftJoin('album.cache', 'cache', 'cache.projectionKey = :pk AND cache.valid = 1', {pk: session.user.projectionKey})
      .leftJoin('cache.cover', 'cover')
      .leftJoin('cover.directory', 'directory')
      .select(['album', 'cache', 'cover.name', 'directory.name', 'directory.path'])
      .getMany();

    return result;
  }

  protected async invalidateDBCache(): Promise<void> {
    // Invalidate all album cache entries
    const connection = await SQLConnection.getConnection();
    await connection.getRepository(ProjectedAlbumCacheEntity)
      .createQueryBuilder()
      .update()
      .set({valid: false})
      .execute();
  }

  private async updateAlbums(session: SessionContext): Promise<void> {
    Logger.debug(LOG_TAG, 'Updating derived album data');
    const connection = await SQLConnection.getConnection();
    const albums = await connection
      .getRepository(SavedSearchEntity)
      .createQueryBuilder('album')
      .leftJoinAndSelect('album.cache', 'cache', 'cache.projectionKey = :pk AND cache.valid = 1', {pk: session.user.projectionKey})
      .getMany();

    for (const a of albums) {
      try {
        if (a.cache?.valid === true) {
          continue;
        }
        await ObjectManagers.getInstance().ProjectedCacheManager
          .setAndGetCacheForAlbum(connection, session, {
            id: a.id,
            searchQuery: a.searchQuery,
            name: a.name
          });
        // giving back the control to the main event loop (Macrotask queue)
        // https://blog.insiderattack.net/promises-next-ticks-and-immediates-nodejs-event-loop-part-3-9226cbe7a6aa
        await new Promise(setImmediate);
      } catch (e) {
        Logger.error(LOG_TAG, `Could not update album data for album '${a.name}', query: ${JSON.stringify(a.searchQuery)}`, e);
        NotificationManager.warning(`Could not update album data`, {
          id: a.id,
          searchQuery: a.searchQuery,
          name: a.name,
          error: e.toString()
        });
      }
    }
    this.resetMemoryCache();
  }

}
