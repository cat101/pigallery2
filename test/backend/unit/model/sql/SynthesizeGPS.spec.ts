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
    // Most tests express the new tiered algorithm with threshold=3 (default).
    // The "honors SyntheticGPSMinLibSamples" test below overrides this.
    Config.Indexing.PhotoLocation.SyntheticGPSMinLibSamples = 3;
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

  it('uses the library city-level mean when ≥ minLibSamples anchors exist', async () => {
    // 3 anchors at (A,B,C) → meets threshold → lib-city wins over the provider.
    await seedMedia(dirId, {name: 'anchor1.jpg', country: 'A', state: 'B', city: 'C', lat: 10, lon: 20});
    await seedMedia(dirId, {name: 'anchor2.jpg', country: 'A', state: 'B', city: 'C', lat: 12, lon: 22});
    await seedMedia(dirId, {name: 'anchor3.jpg', country: 'A', state: 'B', city: 'C', lat: 14, lon: 24});
    await seedMedia(dirId, {name: 'target.jpg',  country: 'A', state: 'B', city: 'C'});
    let providerCalled = false;
    GeocodeProviderRegistry.register(KEY, () => ({
      ready: () => true,
      reverse: () => undefined,
      geocode: () => {
        providerCalled = true;
        return {country: 'A', state: 'B', city: 'C', latitude: 99, longitude: 99};
      },
      isAdmin1: () => false,
    }));
    const r = await new IndexingManager().synthesizeGPS(dirId);
    expect(r.updated).to.equal(1);
    expect(providerCalled).to.equal(false);
    const g = await getGPS('target.jpg');
    expect(g.lat).to.equal(12);  // mean of 10,12,14
    expect(g.lon).to.equal(22);  // mean of 20,22,24
  });

  it('prefers geo-city over lib-state when lib-city is below threshold (Piscataway scenario)', async () => {
    // ONE mis-located anchor in the same state (US, NJ) — n=1 < minLibSamples=3.
    // The pre-fix algorithm would have anchored every other NJ photo at this
    // one photo's coords. Now: lib-city miss → geo-city match wins.
    await seedMedia(dirId, {name: 'rutgers-wrong.jpg', country: 'US', state: 'NJ', city: 'Rutgers',
      lat: 40.350, lon: -74.485});  // not actually at Rutgers
    await seedMedia(dirId, {name: 'piscataway.jpg', country: 'US', state: 'NJ', city: 'Piscataway'});
    GeocodeProviderRegistry.register(KEY, () => ({
      ready: () => true,
      reverse: () => undefined,
      geocode: (q) => q.city === 'Piscataway'
        ? {country: 'US', state: 'NJ', city: 'Piscataway', latitude: 40.499, longitude: -74.399}
        : undefined,
      isAdmin1: () => false,
    }));
    const r = await new IndexingManager().synthesizeGPS(dirId);
    expect(r.updated).to.equal(1);
    const g = await getGPS('piscataway.jpg');
    expect(g.lat).to.equal(40.499);  // cities-db Piscataway, NOT the misplaced Rutgers anchor
    expect(g.lon).to.equal(-74.399);
  });

  it('calls provider.geocode at the city tier when lib-city is below threshold', async () => {
    // No library anchors at all → tier 1 (city) goes straight to the provider.
    await seedMedia(dirId, {name: 'target.jpg', country: 'A', state: 'B', city: 'X'});
    const calls: any[] = [];
    GeocodeProviderRegistry.register(KEY, () => ({
      ready: () => true,
      reverse: () => undefined,
      geocode: (q) => {
        calls.push(q);
        // Returning a city-shaped result so granularity='city' (matches tier 1).
        return {country: 'A', state: 'B', city: 'X', latitude: 55, longitude: 66};
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

  it('does not mistake a country fallthrough inside the provider for a city/state match', async () => {
    // Photo has only country → provider returns a country-shaped result.
    // Granularity guard must accept it at tier 3, not tier 1.
    await seedMedia(dirId, {name: 'target.jpg', country: 'Foo'});
    GeocodeProviderRegistry.register(KEY, () => ({
      ready: () => true,
      reverse: () => undefined,
      geocode: () => ({country: 'Foo', latitude: 7, longitude: 8}),  // no city/state → country granularity
      isAdmin1: () => false,
    }));
    const r = await new IndexingManager().synthesizeGPS(dirId);
    expect(r.updated).to.equal(1);
    const g = await getGPS('target.jpg');
    expect(g.lat).to.equal(7);
    expect(g.lon).to.equal(8);
  });

  it('falls through to lib-country when its sample count meets the threshold', async () => {
    // 3 anchors spread across different cities in country A — lib-country=3.
    // Target's city/state don't match anything in library or provider, so
    // tier 1/2 miss and tier 3 lib-country wins.
    await seedMedia(dirId, {name: 'a1.jpg', country: 'A', state: 'B', city: 'X', lat: 60, lon: 70});
    await seedMedia(dirId, {name: 'a2.jpg', country: 'A', state: 'B', city: 'Y', lat: 70, lon: 80});
    await seedMedia(dirId, {name: 'a3.jpg', country: 'A', state: 'B', city: 'Z', lat: 80, lon: 90});
    await seedMedia(dirId, {name: 'target.jpg', country: 'A', state: 'B', city: 'NotInLibrary'});
    GeocodeProviderRegistry.register(KEY, () => ({
      ready: () => true,
      reverse: () => undefined,
      geocode: () => undefined,
      isAdmin1: () => false,
    }));
    const r = await new IndexingManager().synthesizeGPS(dirId);
    expect(r.updated).to.equal(1);
    const g = await getGPS('target.jpg');
    expect(g.lat).to.equal(70);   // mean of 60,70,80
    expect(g.lon).to.equal(80);   // mean of 70,80,90
  });

  it('skips when both lib (below threshold) and provider miss everywhere', async () => {
    // Single anchor at (A,B,Other) is below threshold → ignored. Provider misses
    // at every tier. Target should be left without GPS — NOT pulled to the
    // single-anchor location like the original chain would have done.
    await seedMedia(dirId, {name: 'lone-anchor.jpg', country: 'A', state: 'B', city: 'Other', lat: 30, lon: 40});
    await seedMedia(dirId, {name: 'target.jpg', country: 'A', state: 'B', city: 'NotInLibrary'});
    GeocodeProviderRegistry.register(KEY, () => ({
      ready: () => true,
      reverse: () => undefined,
      geocode: () => undefined,
      isAdmin1: () => false,
    }));
    const r = await new IndexingManager().synthesizeGPS(dirId);
    expect(r.updated).to.equal(0);
    const g = await getGPS('target.jpg');
    expect(g.lat).to.equal(null);
    expect(g.lon).to.equal(null);
  });

  it('honors the SyntheticGPSMinLibSamples config (1 restores original library-first-always behaviour)', async () => {
    Config.Indexing.PhotoLocation.SyntheticGPSMinLibSamples = 1;
    // Single anchor — with threshold=1 it should win at tier 1 (lib-city).
    await seedMedia(dirId, {name: 'anchor.jpg', country: 'A', state: 'B', city: 'C', lat: 11, lon: 22});
    await seedMedia(dirId, {name: 'target.jpg', country: 'A', state: 'B', city: 'C'});
    let providerCalled = false;
    GeocodeProviderRegistry.register(KEY, () => ({
      ready: () => true,
      reverse: () => undefined,
      geocode: () => { providerCalled = true; return undefined; },
      isAdmin1: () => false,
    }));
    await new IndexingManager().synthesizeGPS(dirId);
    expect(providerCalled).to.equal(false);
    const g = await getGPS('target.jpg');
    expect(g.lat).to.equal(11);
    expect(g.lon).to.equal(22);
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
