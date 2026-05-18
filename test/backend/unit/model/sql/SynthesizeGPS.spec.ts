/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from 'chai';
import {SQLConnection} from '../../../../../src/backend/model/database/SQLConnection';
import {IndexingManager} from '../../../../../src/backend/model/database/IndexingManager';
import {MediaEntity} from '../../../../../src/backend/model/database/enitites/MediaEntity';
import {DirectoryEntity} from '../../../../../src/backend/model/database/enitites/DirectoryEntity';
import {Config} from '../../../../../src/common/config/private/Config';
import {DBTestHelper} from '../../../DBTestHelper';
import {
  GeocodeProviderRegistry,
  GeocodeProvider,
} from '../../../../../src/backend/model/database/OfflineGeocodeProvider';

declare let describe: any;
declare const after: any;
// sqlite-only: synthesizeGPS uses raw SQLite column-name SQL ("metadataPositionDataGPSDataLatitude" etc.)
// and the same MyISAM-style identifiers don't apply on MySQL. The MySQL branch
// of DBTestHelper expects a running MySQL server which isn't part of the dev
// container; restricting to sqlite keeps the unit suite self-contained.
describe = DBTestHelper.describe({sqlite: true, mysql: false});

// Minimal raw inserts so we can seed media rows without going through
// IndexingManager.saveMedia (which has its own side effects).
async function seedDir(name = 'test-dir', path = './'): Promise<number> {
  const conn = await SQLConnection.getConnection();
  const rep = conn.getRepository(DirectoryEntity);
  const r = await rep.insert({
    name,
    path,
    lastModified: Date.now(),
    lastScanned: Date.now(),
  } as DirectoryEntity);
  return r.identifiers[0]['id'] as number;
}

async function seedMedia(dirId: number, args: {
  name: string;
  country?: string | null;
  state?: string | null;
  city?: string | null;
  lat?: number | null;
  lon?: number | null;
}): Promise<number> {
  const conn = await SQLConnection.getConnection();
  const r = await conn.query(
    `INSERT INTO media_entity
       (name, type, directoryId,
        metadataCreationdate, metadataCreationdateoffset, metadataFilesize,
        metadataSizeWidth, metadataSizeHeight,
        metadataPositionDataCountry, metadataPositionDataState,
        metadataPositionDataCity, metadataPositionDataGPSDataLatitude,
        metadataPositionDataGPSDataLongitude, metadataRating, metadataPersonslength)
     VALUES (?, 'PhotoEntity', ?, 0, 0, 1, 1, 1, ?, ?, ?, ?, ?, 0, 0)`,
    [args.name, dirId,
      args.country ?? null, args.state ?? null, args.city ?? null,
      args.lat ?? null, args.lon ?? null]);
  return r as number;
}

async function getGPS(name: string): Promise<{lat: number | null; lon: number | null}> {
  const conn = await SQLConnection.getConnection();
  const rows = await conn.query(
    'SELECT metadataPositionDataGPSDataLatitude AS lat,'
    + ' metadataPositionDataGPSDataLongitude AS lon'
    + ' FROM media_entity WHERE name = ?', [name]);
  const r = rows[0];
  return {lat: r?.lat ?? null, lon: r?.lon ?? null};
}

describe('IndexingManager.synthesizeGPS', (sqlHelper: DBTestHelper) => {
  let dirId: number;

  const KEY = 'offline-cities1000';

  beforeEach(async () => {
    await sqlHelper.initDB();
    GeocodeProviderRegistry.reset();
    Config.Indexing.PhotoLocation.SyntheticGPSEnabled = true;
    Config.Indexing.PhotoLocation.ReverseGeocodeEnabled = true;
    dirId = await seedDir();
  });

  afterEach(async () => {
    GeocodeProviderRegistry.reset();
    await SQLConnection.close();
  });

  after(async () => {
    await sqlHelper.clearDB();
  });

  it('is a noop when SyntheticGPSEnabled is false', async () => {
    Config.Indexing.PhotoLocation.SyntheticGPSEnabled = false;
    await seedMedia(dirId, {name: 'a.jpg', country: 'X'});
    const r = await new IndexingManager().synthesizeGPS();
    expect(r).to.deep.equal({updated: 0, scanned: 0});
  });

  it('picks an exact (country, state, city) library centroid when one exists', async () => {
    await seedMedia(dirId, {name: 'anchor1.jpg', country: 'A', state: 'B', city: 'C', lat: 10, lon: 20});
    await seedMedia(dirId, {name: 'anchor2.jpg', country: 'A', state: 'B', city: 'C', lat: 12, lon: 22});
    await seedMedia(dirId, {name: 'target.jpg',  country: 'A', state: 'B', city: 'C'});
    GeocodeProviderRegistry.register(KEY, () => ({
      ready: () => true,
      reverse: () => undefined,
      geocode: () => undefined,
      isAdmin1: () => false,
    }));
    const r = await new IndexingManager().synthesizeGPS(dirId);
    expect(r.updated).to.equal(1);
    const g = await getGPS('target.jpg');
    expect(g.lat).to.equal(11);
    expect(g.lon).to.equal(21);
  });

  it('falls through to library state-level centroid when no exact city match exists', async () => {
    await seedMedia(dirId, {name: 'anchor.jpg', country: 'A', state: 'B', city: 'Other', lat: 30, lon: 40});
    await seedMedia(dirId, {name: 'target.jpg', country: 'A', state: 'B', city: 'NotInLibrary'});
    GeocodeProviderRegistry.register(KEY, () => ({
      ready: () => true,
      reverse: () => undefined,
      // Geocode misses so the chain falls past it to library country.
      geocode: () => undefined,
      isAdmin1: () => false,
    }));
    const r = await new IndexingManager().synthesizeGPS(dirId);
    expect(r.updated).to.equal(1);
    const g = await getGPS('target.jpg');
    expect(g.lat).to.equal(30);
    expect(g.lon).to.equal(40);
  });

  it('calls provider.geocode(triple) between library state and library country', async () => {
    // No library anchor at (A,B,X) or (A,B,*) → goes to provider.
    await seedMedia(dirId, {name: 'target.jpg', country: 'A', state: 'B', city: 'X'});
    const calls: any[] = [];
    GeocodeProviderRegistry.register(KEY, () => ({
      ready: () => true,
      reverse: () => undefined,
      geocode: (q) => {
        calls.push(q);
        return {latitude: 55, longitude: 66};
      },
      isAdmin1: () => false,
    }));
    const r = await new IndexingManager().synthesizeGPS(dirId);
    expect(r.updated).to.equal(1);
    expect(calls.length).to.equal(1);
    expect(calls[0]).to.include({country: 'A', state: 'B', city: 'X'});
    const g = await getGPS('target.jpg');
    expect(g.lat).to.equal(55);
    expect(g.lon).to.equal(66);
  });

  it('falls back to library country centroid when provider misses', async () => {
    await seedMedia(dirId, {name: 'anchor.jpg', country: 'A', state: 'B', city: 'X', lat: 70, lon: 80});
    await seedMedia(dirId, {name: 'target.jpg', country: 'A', state: 'B', city: 'Z'});
    GeocodeProviderRegistry.register(KEY, () => ({
      ready: () => true,
      reverse: () => undefined,
      geocode: () => undefined,
      isAdmin1: () => false,
    }));
    const r = await new IndexingManager().synthesizeGPS(dirId);
    expect(r.updated).to.equal(1);
    const g = await getGPS('target.jpg');
    // (A,*,*) library centroid is the only anchor, so we land there.
    expect(g.lat).to.equal(70);
    expect(g.lon).to.equal(80);
  });

  it('skips rows that get no centroid at all (no library, no geocode)', async () => {
    // Country alone, no library samples, geocoder returns nothing.
    await seedMedia(dirId, {name: 'target.jpg', country: 'Atlantis'});
    GeocodeProviderRegistry.register(KEY, () => ({
      ready: () => true,
      reverse: () => undefined,
      geocode: () => undefined,
      isAdmin1: () => false,
    }));
    const r = await new IndexingManager().synthesizeGPS(dirId);
    expect(r.scanned).to.equal(1);
    expect(r.updated).to.equal(0);
    const g = await getGPS('target.jpg');
    expect(g.lat).to.equal(null);
    expect(g.lon).to.equal(null);
  });

  it('scopes by parentDirId — does not touch photos in other directories', async () => {
    const otherDirId = await seedDir('other-dir', './');
    await seedMedia(otherDirId, {name: 'other.jpg', country: 'A'});
    await seedMedia(dirId, {name: 'target.jpg', country: 'A'});
    GeocodeProviderRegistry.register(KEY, () => ({
      ready: () => true,
      reverse: () => undefined,
      geocode: () => ({country: 'A', latitude: 1, longitude: 2}),
      isAdmin1: () => false,
    }));
    const r = await new IndexingManager().synthesizeGPS(dirId);
    expect(r.scanned).to.equal(1);
    expect(r.updated).to.equal(1);
    expect((await getGPS('other.jpg')).lat).to.equal(null);
    expect((await getGPS('target.jpg')).lat).to.equal(1);
  });

  it('mirrors the synthesised GPS back into a provided patchMedia array', async () => {
    await seedMedia(dirId, {name: 'target.jpg', country: 'A'});
    GeocodeProviderRegistry.register(KEY, () => ({
      ready: () => true,
      reverse: () => undefined,
      geocode: () => ({country: 'A', latitude: 9.99, longitude: 8.88}),
      isAdmin1: () => false,
    }));
    const mediaArr: any[] = [{name: 'target.jpg', metadata: {}}];
    await new IndexingManager().synthesizeGPS(dirId, mediaArr);
    expect(mediaArr[0].metadata.positionData?.GPSData?.latitude).to.equal(9.99);
    expect(mediaArr[0].metadata.positionData?.GPSData?.longitude).to.equal(8.88);
  });
});
