import {DirectoryBaseDTO, DirectoryDTOUtils, DirectoryPathDTO, ParentDirectoryDTO} from '../../../common/entities/DirectoryDTO';
import {DirectoryEntity} from './enitites/DirectoryEntity';
import {SQLConnection} from './SQLConnection';
import {PhotoEntity, PhotoMetadataEntity} from './enitites/PhotoEntity';
import {Utils} from '../../../common/Utils';
import {PhotoMetadata,} from '../../../common/entities/PhotoDTO';
import {Connection, ObjectLiteral, Repository} from 'typeorm';
import {MediaEntity} from './enitites/MediaEntity';
import {MediaDTO, MediaDTOUtils} from '../../../common/entities/MediaDTO';
import {VideoEntity} from './enitites/VideoEntity';
import {FileEntity} from './enitites/FileEntity';
import {FileDTO} from '../../../common/entities/FileDTO';
import {NotificationManager} from '../NotifocationManager';
import {ObjectManagers} from '../ObjectManagers';
import {Logger} from '../../Logger';
import {ServerPG2ConfMap, ServerSidePG2ConfAction,} from '../../../common/PG2ConfMap';
import {ProjectPath} from '../../ProjectPath';
import * as path from 'path';
import * as fs from 'fs';
import {SearchQueryDTO} from '../../../common/entities/SearchQueryDTO';
import {PersonEntry} from './enitites/person/PersonEntry';
import {PersonJunctionTable} from './enitites/person/PersonJunctionTable';
import {MDFileEntity} from './enitites/MDFileEntity';
import {MDFileDTO} from '../../../common/entities/MDFileDTO';
import {DiskManager} from '../fileaccess/DiskManager';
import {MetadataLoader} from '../fileaccess/MetadataLoader';
import {ProjectedDirectoryCacheEntity} from './enitites/ProjectedDirectoryCacheEntity';
import {Config} from '../../../common/config/private/Config';
import {GeocodeProviderRegistry} from './OfflineGeocodeProvider';
import {OFFLINE_CITIES1000_PROVIDER} from '../../../common/config/private/PrivateConfig';

const LOG_TAG = '[IndexingManager]';

export class IndexingManager {
  SavingReady: Promise<void> = null;
  private SavingReadyPR: () => void = null;
  private savingQueue: { dir: ParentDirectoryDTO; promise: Promise<void>; resolve: () => void; reject: (e: any) => void }[] = [];
  private isSaving = false;

  get IsSavingInProgress(): boolean {
    return this.SavingReady !== null;
  }

  private static async processServerSidePG2Conf(
    parent: DirectoryPathDTO,
    files: FileDTO[]
  ): Promise<void> {
    for (const f of files) {
      if (ServerPG2ConfMap[f.name] === ServerSidePG2ConfAction.SAVED_SEARCH) {
        const fullMediaPath = path.join(
          ProjectPath.ImageFolder,
          parent.path,
          parent.name,
          f.name
        );

        Logger.silly(
          LOG_TAG,
          'Saving saved-searches to DB from:',
          fullMediaPath
        );
        const savedSearches: { name: string; searchQuery: SearchQueryDTO }[] =
          JSON.parse(await fs.promises.readFile(fullMediaPath, 'utf8'));
        for (const s of savedSearches) {
          await ObjectManagers.getInstance().AlbumManager.addIfNotExistSavedSearch(
            s.name,
            s.searchQuery,
            true
          );
        }
      }
    }
  }

  /**
   * Indexes a dir.
   *
   *  - Default: returns early with the scanned version; save happens in the
   *    background.
   *  - `waitForSave = true`: blocks until saveToDB resolves (lazy reindex path).
   *  - `saveDeadlineMs` (only meaningful when `waitForSave` is false):
   *    races the *entire* scan+save chain against this deadline. If the chain
   *    finishes inside the window we mirror its `positionData` mutations into
   *    the response so synthesised GPS (from the post-save GPS-from-text pass)
   *    is visible on the very first request. If the deadline expires first,
   *    the scan/save keep running in the background and we return a
   *    `syncing = true` stub so the frontend can poll until the work
   *    completes and the DB has the content.
   */
  public async indexDirectory(
    relativeDirectoryName: string,
    waitForSave = false,
    saveDeadlineMs?: number
  ): Promise<ParentDirectoryDTO> {
    if (saveDeadlineMs != null && saveDeadlineMs > 0 && !waitForSave) {
      return this.indexDirectoryWithDeadline(relativeDirectoryName, saveDeadlineMs);
    }
    return this.indexDirectoryCore(relativeDirectoryName, waitForSave);
  }

  // Tracks dir paths that are scanning/saving in the background after a
  // previous request hit the deadline and returned a syncing stub. While a
  // dir is in this set, subsequent polls short-circuit to another stub
  // instead of starting a parallel scan.
  private inflightBgIndex = new Set<string>();

  // Sentinel used by the deadline race to distinguish "scan finished" from
  // "deadline expired" without a discriminated-union wrapper.
  private static readonly INDEX_TIMEOUT = Symbol('index-timeout');

  private async indexDirectoryWithDeadline(
    relativeDirectoryName: string,
    deadlineMs: number
  ): Promise<ParentDirectoryDTO> {
    // Already running from a previous timed-out request? Return another stub
    // immediately so the user keeps polling against the existing scan rather
    // than kicking off a duplicate one.
    if (this.inflightBgIndex.has(relativeDirectoryName)) {
      return this.makeSyncingStub(relativeDirectoryName);
    }
    this.inflightBgIndex.add(relativeDirectoryName);
    const work = this.indexDirectoryCore(relativeDirectoryName, true)
      .finally(() => this.inflightBgIndex.delete(relativeDirectoryName));
    const timeout = new Promise<typeof IndexingManager.INDEX_TIMEOUT>(r =>
      setTimeout(() => r(IndexingManager.INDEX_TIMEOUT), deadlineMs));
    const result = await Promise.race([work, timeout]);
    if (result !== IndexingManager.INDEX_TIMEOUT) {
      return result as ParentDirectoryDTO;
    }
    // Timed out. Make sure the still-running work's rejection (if any) can't
    // surface as an unhandled rejection after the response is sent.
    work.catch(console.error);
    return this.makeSyncingStub(relativeDirectoryName);
  }

  private makeSyncingStub(relativeDirectoryName: string): ParentDirectoryDTO {
    const trimmed = relativeDirectoryName.replace(/[\\/]+$/, '');
    const lastSep = Math.max(
      trimmed.lastIndexOf('/'),
      trimmed.lastIndexOf('\\')
    );
    const name = lastSep < 0 ? trimmed : trimmed.substring(lastSep + 1);
    const dirPath = lastSep < 0 ? './' : trimmed.substring(0, lastSep) + '/';
    return {
      id: 0,
      name,
      path: dirPath,
      lastModified: Date.now(),
      isPartial: true,
      syncing: true,
      parent: null,
      directories: [],
      media: [],
      metaFile: [],
      cache: {mediaCount: 0},
    } as unknown as ParentDirectoryDTO;
  }

  private async indexDirectoryCore(
    relativeDirectoryName: string,
    waitForSave: boolean
  ): Promise<ParentDirectoryDTO> {
    try {
      // Check if root is still a valid (non-empty) folder
      // With weak devices, it is possible that the media that stores
      // the galley gets unmounted that triggers a full gallery wipe.
      // Prevent it by stopping indexing on an empty folder.
      if (fs.readdirSync(ProjectPath.ImageFolder).length === 0) {
        throw new Error('Root directory is empty. This is probably error and would erase gallery database. Stopping indexing.');
      }

      const scannedDirectory = await DiskManager.scanDirectory(
        relativeDirectoryName
      );

      const dirClone = Utils.clone(scannedDirectory);
      // filter server side only config from returning
      dirClone.metaFile = dirClone.metaFile.filter(
        (m) => !ServerPG2ConfMap[m.name]
      );

      DirectoryDTOUtils.addReferences(dirClone);

      // Local helper that copies any positionData mutations (e.g. GPS
      // synthesised from country/state/city during saveToDB) from
      // scannedDirectory.media back into dirClone.media by name. saveToDB
      // mutates scannedDirectory in place, but dirClone is a deep clone
      // captured before the save, so the response would otherwise miss the
      // just-derived coords on the first call.
      const mirrorSavedPositionData = () => {
        const src = new Map(scannedDirectory.media.map(m => [m.name, m]));
        for (const m of dirClone.media) {
          const fresh = src.get(m.name);
          if (fresh && (fresh as PhotoEntity).metadata) {
            (m as PhotoEntity).metadata.positionData =
              (fresh as PhotoEntity).metadata.positionData;
          }
        }
      };

      if (waitForSave === true) {
        await this.queueForSave(scannedDirectory);
        mirrorSavedPositionData();
        return dirClone;
      }

      // save directory to DB in the background
      this.queueForSave(scannedDirectory).catch(console.error);
      return dirClone;
    } catch (error) {
      NotificationManager.warning(
        'Unknown indexing error for: ' + relativeDirectoryName,
        error.toString()
      );
      console.error(error);
      throw error;
    }
  }

  async resetDB(): Promise<void> {
    Logger.info(LOG_TAG, 'Resetting DB');
    const connection = await SQLConnection.getConnection();
    await connection
      .getRepository(DirectoryEntity)
      .createQueryBuilder('directory')
      .delete()
      .execute();
    // Cascading delete on directory_entity already wipes the on-disk geo
    // columns. The pieces below are in-process caches that survive a DB
    // wipe and would otherwise hand stale answers back to the next pass.
    MetadataLoader.clearCaches();
    this.inflightBgIndex.clear();
    ObjectManagers.getInstance().LocationManager?.clearCache();
  }

  public async saveToDB(scannedDirectory: ParentDirectoryDTO): Promise<void> {
    this.isSaving = true;
    try {
      const connection = await SQLConnection.getConnection();
      const serverSideConfigs = scannedDirectory.metaFile.filter(
        (m) => !!ServerPG2ConfMap[m.name]
      );
      scannedDirectory.metaFile = scannedDirectory.metaFile.filter(
        (m) => !ServerPG2ConfMap[m.name]
      );
      const currentDirId: number = await this.saveParentDir(
        connection,
        scannedDirectory
      );
      await this.saveChildDirs(connection, currentDirId, scannedDirectory);
      await this.saveMedia(connection, currentDirId, scannedDirectory.media);
      await this.saveMetaFiles(connection, currentDirId, scannedDirectory);
      await IndexingManager.processServerSidePG2Conf(scannedDirectory, serverSideConfigs);
      // Incremental GPS-from-text synthesis for the photos just persisted in
      // this dir (controlled by Indexing.PhotoLocation.SyntheticGPSEnabled).
      // The centroid index is rebuilt over the whole library each time, so a
      // new dir's missing-GPS photos benefit from sibling-dir GPS samples
      // without waiting for the full Indexing job to complete. Pass the
      // in-memory media array so synthesized coords also land on the response
      // object that indexDirectory returns on the same request — otherwise
      // the first browse of a folder gets text-only rows and the map widget
      // stays empty until the next refresh.
      try {
        await this.synthesizeGPS(currentDirId, scannedDirectory.media);
      } catch (e) {
        Logger.error(LOG_TAG, 'synthesizeGPS failed for dir ' + currentDirId + ': ' + e);
      }
      await ObjectManagers.getInstance().onDataChange(scannedDirectory);
    } finally {
      this.isSaving = false;
    }
  }

  // Todo fix it, once typeorm support connection pools for sqlite
  /**
   * Queues up a directory to save to the DB.
   * Returns a promise that resolves when the directory is saved.
   */
  protected async queueForSave(
    scannedDirectory: ParentDirectoryDTO
  ): Promise<void> {
    // Is this dir already queued for saving?
    const existingIndex = this.savingQueue.findIndex(
      (entry): boolean =>
        entry.dir.name === scannedDirectory.name &&
        entry.dir.path === scannedDirectory.path &&
        entry.dir.lastModified === scannedDirectory.lastModified &&
        entry.dir.lastScanned === scannedDirectory.lastScanned &&
        (entry.dir.media || entry.dir.media.length) ===
        (scannedDirectory.media || scannedDirectory.media.length) &&
        (entry.dir.metaFile || entry.dir.metaFile.length) ===
        (scannedDirectory.metaFile || scannedDirectory.metaFile.length)
    );
    if (existingIndex !== -1) {
      return this.savingQueue[existingIndex].promise;
    }

    // queue for saving
    let resolveFn: () => void;
    let rejectFn: (e: any) => void;
    const promise = new Promise<void>((resolve, reject): void => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    this.savingQueue.push({dir: scannedDirectory, promise, resolve: resolveFn, reject: rejectFn});

    if (this.savingQueue.length > 100) {
      Logger.warn(LOG_TAG, 'Saving queue is growing large:', this.savingQueue.length);
    }

    this.runSavingLoop().catch(console.error);

    return promise;
  }

  protected async runSavingLoop(): Promise<void> {

    // start saving if not already started
    if (!this.SavingReady) {
      this.SavingReady = new Promise<void>((resolve): void => {
        this.SavingReadyPR = resolve;
      });
    }
    try {
      while (this.isSaving === false && this.savingQueue.length > 0) {
        const item = this.savingQueue[0];
        try {
          await this.saveToDB(item.dir);
          item.resolve();
        } catch (e) {
          // reject current and remaining queued items to avoid hanging promises
          item.reject(e);
          this.savingQueue.shift();
          for (const remaining of this.savingQueue) {
            remaining.reject(e);
          }
          this.savingQueue = [];
          this.checkSavingReady();
          throw e;
        }
        this.savingQueue.shift();
      }
    } finally {
      this.checkSavingReady();
    }
  }

  protected async saveParentDir(
    connection: Connection,
    scannedDirectory: ParentDirectoryDTO
  ): Promise<number> {
    const directoryRepository = connection.getRepository(DirectoryEntity);
    const projDirCacheRep = connection.getRepository(ProjectedDirectoryCacheEntity);

    const currentDir: DirectoryEntity = await directoryRepository
      .createQueryBuilder('directory')
      .where('directory.name = :name AND directory.path = :path', {
        name: scannedDirectory.name,
        path: scannedDirectory.path,
      })
      .getOne();
    if (currentDir) {
      // Updated parent dir (if it was in the DB previously)
      currentDir.lastModified = scannedDirectory.lastModified;
      currentDir.lastScanned = scannedDirectory.lastScanned;
      await directoryRepository.save(currentDir);
      return currentDir.id;
    } else {
      return (
        await directoryRepository.insert({
          lastModified: scannedDirectory.lastModified,
          lastScanned: scannedDirectory.lastScanned,
          name: scannedDirectory.name,
          path: scannedDirectory.path,
        } as DirectoryEntity)
      ).identifiers[0]['id'];
    }
  }

  protected async saveChildDirs(
    connection: Connection,
    currentDirId: number,
    scannedDirectory: ParentDirectoryDTO
  ): Promise<void> {
    const directoryRepository = connection.getRepository(DirectoryEntity);

    // update subdirectories that does not have a parent
    await directoryRepository
      .createQueryBuilder()
      .update(DirectoryEntity)
      .set({parent: currentDirId as unknown})
      .where('path = :path', {
        path: DiskManager.pathFromParent(scannedDirectory),
      })
      .andWhere('name NOT LIKE :root', {root: DiskManager.dirName('.')})
      .andWhere('parent IS NULL')
      .execute();

    // save subdirectories
    const childDirectories = await directoryRepository
      .createQueryBuilder('directory')
      .leftJoinAndSelect('directory.parent', 'parent')
      .where('directory.parent = :dir', {
        dir: currentDirId,
      })
      .getMany();

    for (const directory of scannedDirectory.directories) {
      // Was this child Dir already indexed before?
      const dirIndex = childDirectories.findIndex(
        (d): boolean => d.name === directory.name
      );

      if (dirIndex !== -1) {
        // directory found
        childDirectories.splice(dirIndex, 1);
      } else {
        // dir does not exist yet
        directory.parent = {id: currentDirId} as ParentDirectoryDTO;
        (directory as DirectoryEntity).lastScanned = null; // new child dir, not fully scanned yet
        const d = await directoryRepository.insert(
          directory as DirectoryEntity
        );

        await this.saveMedia(
          connection,
          d.identifiers[0]['id'],
          directory.media
        );
      }
    }

    // Remove child Dirs that are not anymore in the parent dir
    await directoryRepository.remove(childDirectories, {
      chunk: Math.max(Math.ceil(childDirectories.length / 500), 1),
    });
  }

  protected async saveMetaFiles(
    connection: Connection,
    currentDirID: number,
    scannedDirectory: ParentDirectoryDTO
  ): Promise<void> {
    const fileRepository = connection.getRepository(FileEntity);
    const MDfileRepository = connection.getRepository(MDFileEntity);
    // save files
    const indexedMetaFiles = await fileRepository
      .createQueryBuilder('file')
      .where('file.directory = :dir', {
        dir: currentDirID,
      })
      .getMany();

    const metaFilesToInsert = [];
    const MDFilesToUpdate = [];
    for (const item of scannedDirectory.metaFile) {
      let metaFile: FileDTO = null;
      for (let j = 0; j < indexedMetaFiles.length; j++) {
        if (indexedMetaFiles[j].name === item.name) {
          metaFile = indexedMetaFiles[j];
          indexedMetaFiles.splice(j, 1);
          break;
        }
      }
      if (metaFile == null) {
        // not in DB yet
        item.directory = null;
        metaFile = Utils.clone(item);
        item.directory = scannedDirectory;
        metaFile.directory = {id: currentDirID} as DirectoryBaseDTO;
        metaFilesToInsert.push(metaFile);
      } else if ((item as MDFileDTO).date) {
        if ((item as MDFileDTO).date != (metaFile as MDFileDTO).date) {
          (metaFile as MDFileDTO).date = (item as MDFileDTO).date;
          MDFilesToUpdate.push(metaFile);
        }
      }
    }

    const MDFiles = metaFilesToInsert.filter(f => !isNaN((f as MDFileDTO).date));
    const generalFiles = metaFilesToInsert.filter(f => isNaN((f as MDFileDTO).date));
    await fileRepository.save(generalFiles, {
      chunk: Math.max(Math.ceil(generalFiles.length / 500), 1),
    });
    await MDfileRepository.save(MDFiles, {
      chunk: Math.max(Math.ceil(MDFiles.length / 500), 1),
    });
    await MDfileRepository.save(MDFilesToUpdate, {
      chunk: Math.max(Math.ceil(MDFilesToUpdate.length / 500), 1),
    });
    await fileRepository.remove(indexedMetaFiles, {
      chunk: Math.max(Math.ceil(indexedMetaFiles.length / 500), 1),
    });
  }

  protected async saveMedia(
    connection: Connection,
    parentDirId: number,
    media: MediaDTO[]
  ): Promise<void> {
    const mediaRepository = connection.getRepository(MediaEntity);
    const photoRepository = connection.getRepository(PhotoEntity);
    const videoRepository = connection.getRepository(VideoEntity);
    // save media
    let indexedMedia = await mediaRepository
      .createQueryBuilder('media')
      .where('media.directory = :dir', {
        dir: parentDirId,
      })
      .getMany();

    const mediaChange = {
      saveP: [] as MediaDTO[], // save/update photo
      saveV: [] as MediaDTO[], // save/update video
      insertP: [] as MediaDTO[], // insert photo
      insertV: [] as MediaDTO[], // insert video
    };
    const personsPerPhoto: { faces: { name: string, mediaId?: number }[]; mediaName: string }[] = [];
    // eslint-disable-next-line @typescript-eslint/prefer-for-of
    for (let i = 0; i < media.length; i++) {
      let mediaItem: MediaDTO = null;
      for (let j = 0; j < indexedMedia.length; j++) {
        if (indexedMedia[j].name === media[i].name) {
          mediaItem = indexedMedia[j];
          indexedMedia.splice(j, 1);
          break;
        }
      }

      const scannedFaces: { name: string }[] = (media[i].metadata as PhotoMetadata).faces || [];
      if ((media[i].metadata as PhotoMetadata).faces) {
        // if it has faces, cache them
        // make the list distinct (some photos may contain the same person multiple times)
        (media[i].metadata as PhotoMetadataEntity).persons = [
          ...new Set(
            (media[i].metadata as PhotoMetadata).faces.map((f) => f.name)
          ),
        ];
      }
      (media[i].metadata as PhotoMetadataEntity).personsLength = (media[i].metadata as PhotoMetadataEntity)?.persons?.length || 0;


      if (mediaItem == null) {
        // Media not in DB yet
        media[i].directory = null;
        mediaItem = Utils.clone(media[i]);
        mediaItem.directory = {id: parentDirId} as DirectoryBaseDTO;
        (MediaDTOUtils.isPhoto(mediaItem)
            ? mediaChange.insertP
            : mediaChange.insertV
        ).push(mediaItem);
      } else {
        // Media already in the DB, only needs to be updated
        delete (mediaItem.metadata as PhotoMetadata).faces;
        if (!Utils.equalsFilter(mediaItem.metadata, media[i].metadata)) {
          mediaItem.metadata = media[i].metadata;
          (MediaDTOUtils.isPhoto(mediaItem)
              ? mediaChange.saveP
              : mediaChange.saveV
          ).push(mediaItem);
        }
      }

      personsPerPhoto.push({
        faces: scannedFaces,
        mediaName: mediaItem.name
      });
    }

    await this.saveChunk(photoRepository, mediaChange.saveP, 100);
    await this.saveChunk(videoRepository, mediaChange.saveV, 100);
    await this.saveChunk(photoRepository, mediaChange.insertP, 100);
    await this.saveChunk(videoRepository, mediaChange.insertV, 100);

    indexedMedia = await mediaRepository
      .createQueryBuilder('media')
      .where('media.directory = :dir', {
        dir: parentDirId,
      })
      .select(['media.name', 'media.id'])
      .getMany();

    const persons: { name: string; mediaId: number }[] = [];
    personsPerPhoto.forEach((group): void => {
      const mIndex = indexedMedia.findIndex(
        (m): boolean => m.name === group.mediaName
      );
      group.faces.forEach((sf) =>
        (sf.mediaId = indexedMedia[mIndex].id)
      );

      persons.push(...group.faces as { name: string; mediaId: number }[]);
      indexedMedia.splice(mIndex, 1);
    });

    await this.savePersonsToMedia(connection, parentDirId, persons);
    await mediaRepository.remove(indexedMedia);
  }

  protected async savePersonsToMedia(
    connection: Connection,
    parentDirId: number,
    scannedFaces: { name: string; mediaId: number }[]
  ): Promise<void> {
    const personJunctionTable = connection.getRepository(PersonJunctionTable);
    const personRepository = connection.getRepository(PersonEntry);

    const persons: { name: string; mediaId: number }[] = [];

    // Make a set
    for (const face of scannedFaces) {
      if (persons.findIndex((f) => f.name === face.name) === -1) {
        persons.push(face);
      }
    }
    await ObjectManagers.getInstance().PersonManager.saveAll(persons);
    // get saved persons without triggering denormalized data update (i.e.: do not use PersonManager.get).
    const savedPersons = await personRepository.find();

    const indexedFaces = await personJunctionTable
      .createQueryBuilder('face')
      .leftJoin('face.media', 'media')
      .where('media.directory = :directory', {
        directory: parentDirId,
      })
      .leftJoinAndSelect('face.person', 'person')
      .getMany();

    const faceToInsert: { person: { id: number }, media: { id: number } }[] = [];
    // eslint-disable-next-line @typescript-eslint/prefer-for-of
    for (let i = 0; i < scannedFaces.length; i++) {
      // was the Person - media connection already indexed
      let face: PersonJunctionTable = null;
      for (let j = 0; j < indexedFaces.length; j++) {
        if (indexedFaces[j].person.name === scannedFaces[i].name) {
          face = indexedFaces[j];
          indexedFaces.splice(j, 1);
          break; // region found, stop processing
        }
      }

      if (face == null) {
        faceToInsert.push({
          person: savedPersons.find(
            (p) => p.name === scannedFaces[i].name
          ),
          media: {id: scannedFaces[i].mediaId}
        });
      }
    }
    if (faceToInsert.length > 0) {
      await this.insertChunk(personJunctionTable, faceToInsert, 100);
    }
    await personJunctionTable.remove(indexedFaces, {
      chunk: Math.max(Math.ceil(indexedFaces.length / 500), 1),
    });
  }

  // Post-indexing pass that writes synthesized GPS into photos that have a
  // text location (country/state/city) but no real GPS. For each such photo,
  // the algorithm walks three granularity tiers — city → state → country —
  // and at each tier prefers an averaged centroid of the user's own
  // GPS-bearing photos at that place (when the library sample count meets
  // `SyntheticGPSMinLibSamples`) over the offline cities database. The
  // sample-count gate stops a single mis-located anchor from dragging every
  // sibling-tagged photo to the wrong spot, while still letting a well-
  // populated city centroid beat a generic-city-database centroid for
  // accuracy in places the user has actually visited.
  //
  // Pass `parentDirId` to limit the target scan to one directory's photos
  // (used by the per-folder lazy reindex path). The centroid index itself is
  // always built over the full library so a single dir's missing-GPS photos
  // still benefit from sibling-dir GPS samples.
  //
  // `patchMedia` is an in-memory media list (the same one being persisted) —
  // when provided, each synthesised row is mirrored back into the matching
  // media object's `metadata.positionData.GPSData`. Needed because the
  // response object returned by `indexDirectory` is a clone captured *before*
  // saveToDB runs: without this mirror, the first browse of a folder gets a
  // text-only response and the map widget stays empty until the next refresh.
  public async synthesizeGPS(
    parentDirId?: number,
    patchMedia?: MediaDTO[]
  ): Promise<{ updated: number; scanned: number }> {
    if (!Config.Indexing.PhotoLocation?.SyntheticGPSEnabled) {
      return {updated: 0, scanned: 0};
    }
    Logger.info(LOG_TAG, parentDirId
      ? `Synthesizing GPS scoped to dir id ${parentDirId}`
      : 'Synthesizing GPS for photos with text location but no GPS');
    const connection = await SQLConnection.getConnection();
    const mediaTable = connection.getRepository(MediaEntity).metadata.tableName;
    type CentroidRow = {
      country: string | null;
      state: string | null;
      city: string | null;
      lat: number;
      lon: number;
      n: number;
    };
    // Raw SQL: TypeORM property-path translation requires going through entity
    // aliases, which doesn't apply to the column names actually written to
    // SQLite. Use the flat column names directly.
    const CC = 'metadataPositionDataCountry';
    const SC = 'metadataPositionDataState';
    const CTY = 'metadataPositionDataCity';
    const LAT = 'metadataPositionDataGPSDataLatitude';
    const LON = 'metadataPositionDataGPSDataLongitude';
    const centroidRows: CentroidRow[] = await connection
      .createQueryBuilder()
      .select(CC, 'country')
      .addSelect(SC, 'state')
      .addSelect(CTY, 'city')
      .addSelect(`AVG(${LAT})`, 'lat')
      .addSelect(`AVG(${LON})`, 'lon')
      .addSelect(`COUNT(*)`, 'n')
      .from(mediaTable, 'media')
      .where(`${LAT} IS NOT NULL`)
      .andWhere(`${LON} IS NOT NULL`)
      .andWhere(`${CC} IS NOT NULL`)
      .groupBy(CC)
      .addGroupBy(SC)
      .addGroupBy(CTY)
      .getRawMany();

    const cityIdx = new Map<string, CentroidRow>();
    const stateIdx = new Map<string, CentroidRow>();
    const countryIdx = new Map<string, CentroidRow>();
    const norm = (s: string | null | undefined) => (s == null ? '' : s.toLowerCase());
    const aggregate = (
      bucket: Map<string, CentroidRow>,
      key: string,
      row: CentroidRow
    ) => {
      const prev = bucket.get(key);
      if (!prev) {
        bucket.set(key, {...row});
        return;
      }
      const total = prev.n + row.n;
      prev.lat = (prev.lat * prev.n + row.lat * row.n) / total;
      prev.lon = (prev.lon * prev.n + row.lon * row.n) / total;
      prev.n = total;
    };
    for (const row of centroidRows) {
      cityIdx.set(`${norm(row.country)}|${norm(row.state)}|${norm(row.city)}`, row);
      aggregate(stateIdx, `${norm(row.country)}|${norm(row.state)}`, row);
      aggregate(countryIdx, `${norm(row.country)}`, row);
    }

    const provider = GeocodeProviderRegistry.get(OFFLINE_CITIES1000_PROVIDER);

    // Pull the directory path + name alongside media id so per-photo log lines
    // can carry the absolute path on disk (operators want to grep their logs
    // for "Foo/bar.jpg" without having to JOIN themselves).
    const dirTable = connection.getRepository(DirectoryEntity).metadata.tableName;
    const targetsQB = connection
      .createQueryBuilder()
      .select('media.id', 'id')
      .addSelect('media.name', 'name')
      .addSelect(`media.${CC}`, 'country')
      .addSelect(`media.${SC}`, 'state')
      .addSelect(`media.${CTY}`, 'city')
      .addSelect('d.path', 'dirPath')
      .addSelect('d.name', 'dirName')
      .from(mediaTable, 'media')
      .innerJoin(dirTable, 'd', 'd.id = media.directoryId')
      .where(`media.${LAT} IS NULL`)
      .andWhere(`media.${CC} IS NOT NULL`);
    if (parentDirId != null) {
      targetsQB.andWhere('media.directoryId = :dirId', {dirId: parentDirId});
    }
    const targets = await targetsQB.getRawMany();
    const patchByName = patchMedia ? new Map(patchMedia.map(m => [m.name, m])) : null;
    const fullPathOf = (t: { dirPath: string; dirName: string; name: string }) =>
      path.join(ProjectPath.ImageFolder, t.dirPath || '', t.dirName || '', t.name);

    let updated = 0;
    const srcCount = {
      libCity: 0, geoCity: 0,
      libState: 0, geoState: 0,
      libCountry: 0, geoCountry: 0,
    };
    let skipped = 0;
    // Build a single UPDATE per row via raw SQL — bypasses TypeORM property-path
    // translation issues for embedded fields.
    const updateStmt = `UPDATE "${mediaTable}" SET "${LAT}" = ?, "${LON}" = ? WHERE id = ?`;
    const rawUpdate = async (lat: number, lon: number, id: number) => {
      await connection.query(updateStmt, [lat, lon, id]);
    };

    // Provider helper returns granularity ('city' | 'state' | 'country') so a
    // city-level call that fell through to country centroid (via the
    // provider's internal cascade) is not mistaken for a city match by the
    // tiered algorithm. Without this, a state-only photo whose state name
    // doesn't resolve would skip the lib-country tier and use the country
    // centroid prematurely.
    type GeoPick = { lat: number; lon: number; granularity: 'city' | 'state' | 'country' };
    const askProvider = (q: { country?: string; state?: string; city?: string }, fullPath: string): GeoPick | null => {
      if (!provider) return null;
      const r = provider.geocode(q, fullPath);
      if (!r || r.latitude == null || r.longitude == null) return null;
      const granularity: GeoPick['granularity'] = r.city ? 'city' : r.state ? 'state' : 'country';
      return {lat: r.latitude, lon: r.longitude, granularity};
    };

    const MIN_LIB_SAMPLES = Math.max(
      1, Config.Indexing.PhotoLocation?.SyntheticGPSMinLibSamples ?? 3);
    const pickFromLib = (
      bucket: Map<string, CentroidRow>, key: string
    ): CentroidRow | null => {
      const r = bucket.get(key);
      return r && r.n >= MIN_LIB_SAMPLES ? r : null;
    };

    for (const t of targets) {
      const c = norm(t.country);
      const s = norm(t.state);
      const ci = norm(t.city);
      const fullPath = fullPathOf(t);
      // At each granularity tier, the library centroid wins ONLY if it has
      // ≥ MIN_LIB_SAMPLES samples; otherwise the offline geocoder is queried
      // at the same granularity. This defuses two failure modes the original
      // single-anchor library-first chain had:
      //   - one mis-located photo dragging every sibling-tagged photo to the
      //     wrong spot (a city's lib mean came from a single photo at the
      //     wrong location);
      //   - lib-state preempting geo-city even when the photo had a city the
      //     cities database could resolve precisely (e.g. a target with a
      //     real city name landing at the state-level mean of one anchor in
      //     a different city of the same state).
      // Order: city tier → state tier → country tier. Each provider call is
      // scoped to the tier (no city / no state) so internal cascading inside
      // the provider doesn't bleed into the next tier — `granularity` from
      // askProvider tells us what the provider actually matched, and we only
      // accept it when it matches the tier we're asking about.
      let pick: { lat: number; lon: number } | null = null;
      let pickSrc: keyof typeof srcCount | null = null;

      // Tier 1 — city granularity (only when the photo has a city).
      if (ci) {
        const lib = pickFromLib(cityIdx, `${c}|${s}|${ci}`);
        if (lib) {
          pick = lib;
          pickSrc = 'libCity';
        } else {
          const geo = askProvider({country: t.country, state: t.state, city: t.city}, fullPath);
          if (geo && geo.granularity === 'city') {
            pick = geo;
            pickSrc = 'geoCity';
          }
        }
      }
      // Tier 2 — state granularity (only when the photo has a state).
      if (!pick && s) {
        const lib = pickFromLib(stateIdx, `${c}|${s}`);
        if (lib) {
          pick = lib;
          pickSrc = 'libState';
        } else {
          const geo = askProvider({country: t.country, state: t.state}, fullPath);
          if (geo && geo.granularity === 'state') {
            pick = geo;
            pickSrc = 'geoState';
          }
        }
      }
      // Tier 3 — country granularity (always tried last if country known).
      if (!pick && c) {
        const lib = pickFromLib(countryIdx, c);
        if (lib) {
          pick = lib;
          pickSrc = 'libCountry';
        } else {
          const geo = askProvider({country: t.country}, fullPath);
          if (geo) {
            pick = geo;
            pickSrc = 'geoCountry';
          }
        }
      }

      if (!pick) {
        Logger.warn('[SyntheticGPS]',
          `${fullPath} — no centroid for ${t.country ?? '*'}/${t.state ?? '*'}/${t.city ?? '*'}; left without GPS`);
        skipped++;
        continue;
      }
      const lat6 = parseFloat(pick.lat.toFixed(6));
      const lon6 = parseFloat(pick.lon.toFixed(6));
      await rawUpdate(lat6, lon6, t.id);
      const inMem = patchByName?.get(t.name);
      if (inMem) {
        const pm = (inMem as PhotoEntity).metadata as PhotoMetadata;
        pm.positionData = pm.positionData || {};
        pm.positionData.GPSData = {latitude: lat6, longitude: lon6};
      }
      if (pickSrc) srcCount[pickSrc]++;
      updated++;
    }
    Logger.info('[SyntheticGPS]',
      `dir=${parentDirId ?? '*'} scanned=${targets.length} updated=${updated}`
      + ` src={lib-city: ${srcCount.libCity}, geo-city: ${srcCount.geoCity},`
      + ` lib-state: ${srcCount.libState}, geo-state: ${srcCount.geoState},`
      + ` lib-country: ${srcCount.libCountry}, geo-country: ${srcCount.geoCountry}}`
      + ` skipped=${skipped} minLibSamples=${MIN_LIB_SAMPLES}`);
    return {updated, scanned: targets.length};
  }

  private checkSavingReady(): void {

    if (!this.savingQueue?.length && this.SavingReady) {
      const pr = this.SavingReadyPR;
      this.SavingReady = null;
      this.SavingReadyPR = null;
      this.savingQueue = [];
      if (pr) {
        pr();
      }
    }
  }

  private async saveChunk<T extends ObjectLiteral>(
    repository: Repository<T>,
    entities: T[],
    size: number
  ): Promise<T[]> {
    if (entities.length === 0) {
      return [];
    }
    if (entities.length < size) {
      return await repository.save(entities);
    }
    let list: T[] = [];
    for (let i = 0; i < entities.length / size; i++) {
      list = list.concat(
        await repository.save(entities.slice(i * size, (i + 1) * size))
      );
    }
    return list;
  }

  private async insertChunk<T extends ObjectLiteral>(
    repository: Repository<T>,
    entities: T[],
    size: number
  ): Promise<number[]> {
    if (entities.length === 0) {
      return [];
    }
    if (entities.length < size) {
      return (await repository.insert(entities)).identifiers.map(
        (i: { id: number }) => i.id
      );
    }
    let list: number[] = [];
    for (let i = 0; i < entities.length / size; i++) {
      list = list.concat(
        (
          await repository.insert(entities.slice(i * size, (i + 1) * size))
        ).identifiers.map((ids) => ids['id'])
      );
    }
    return list;
  }
}
