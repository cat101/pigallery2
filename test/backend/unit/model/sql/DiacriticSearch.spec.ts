/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from 'chai';
import {SQLConnection} from '../../../../../src/backend/model/database/SQLConnection';
import {MediaEntity} from '../../../../../src/backend/model/database/enitites/MediaEntity';
import {DirectoryEntity} from '../../../../../src/backend/model/database/enitites/DirectoryEntity';
import {DBTestHelper} from '../../../DBTestHelper';

declare let describe: any;
declare const after: any;

// SQLite-only: the diacritic-insensitive search toggle
// (Config.Search.DiacriticInsensitive) relies on an `unaccent` UDF registered
// on the better-sqlite3 connection at SQLConnection.createConnection. MySQL
// handles diacritics via *_ci collations and doesn't go through this path.
describe = DBTestHelper.describe({sqlite: true, mysql: false});

async function seedDir(): Promise<number> {
  const conn = await SQLConnection.getConnection();
  const rep = conn.getRepository(DirectoryEntity);
  const r = await rep.insert({
    name: 'test-dir', path: './',
    lastModified: Date.now(), lastScanned: Date.now(),
  } as DirectoryEntity);
  return r.identifiers[0]['id'] as number;
}

async function seedMedia(
  dirId: number,
  args: { name: string; country?: string; state?: string; city?: string; keywords?: string }
): Promise<void> {
  const conn = await SQLConnection.getConnection();
  await conn.query(
    `INSERT INTO media_entity
       (name, type, directoryId,
        metadataCreationdate, metadataCreationdateoffset, metadataFilesize,
        metadataSizeWidth, metadataSizeHeight,
        metadataPositionDataCountry, metadataPositionDataState,
        metadataPositionDataCity, metadataKeywords, metadataRating, metadataPersonslength)
     VALUES (?, 'PhotoEntity', ?, 0, 0, 1, 1, 1, ?, ?, ?, ?, 0, 0)`,
    [args.name, dirId,
      args.country ?? null, args.state ?? null, args.city ?? null,
      args.keywords ?? null]);
}

describe('F4 — diacritic-insensitive search (Search.DiacriticInsensitive)', (sqlHelper: DBTestHelper) => {
  let dirId: number;

  beforeEach(async () => {
    await sqlHelper.initDB();
    dirId = await seedDir();
    // Four city-slot variants of the same place name.
    await seedMedia(dirId, {name: 'p1.jpg', city: 'Córdoba'});            // proper diacritic
    await seedMedia(dirId, {name: 'p2.jpg', city: 'Cordoba'});            // no diacritic
    await seedMedia(dirId, {name: 'p3.jpg', city: 'CORDOBA'});            // all-caps
    await seedMedia(dirId, {name: 'p4.jpg', city: 'AEROPUERTO CORDOBA'}); // embedded
    await seedMedia(dirId, {name: 'p5.jpg', city: 'Bariloche'});          // unrelated
  });

  afterEach(async () => {
    await SQLConnection.close();
  });

  after(async () => {
    await sqlHelper.clearDB();
  });

  it('registers the `unaccent` UDF on connection creation', async () => {
    const conn = await SQLConnection.getConnection();
    const row = await conn.query("SELECT unaccent('Córdoba') as v");
    expect(row[0].v).to.equal('cordoba');
  });

  it('unaccent strips combining diacritics from many scripts', async () => {
    const conn = await SQLConnection.getConnection();
    const expectations = [
      ['Córdoba', 'cordoba'],
      ['CORDOBA', 'cordoba'],
      ['Cordoba', 'cordoba'],
      ['São Paulo', 'sao paulo'],
      ['München', 'munchen'],
      ['Žmín', 'zmin'],
    ];
    for (const [input, expected] of expectations) {
      const row = await conn.query("SELECT unaccent(?) as v", [input]);
      expect(row[0].v).to.equal(expected, `unaccent('${input}')`);
    }
  });

  it('handles NULL gracefully (returns NULL, no crash)', async () => {
    const conn = await SQLConnection.getConnection();
    const row = await conn.query("SELECT unaccent(NULL) as v");
    expect(row[0].v).to.equal(null);
  });

  it('without unaccent: only exact-diacritic-form variants match (default behaviour)', async () => {
    const conn = await SQLConnection.getConnection();
    // What the SQL looks like today when DiacriticInsensitive is OFF.
    const r1 = await conn.query(
      "SELECT name FROM media_entity WHERE metadataPositionDataCity LIKE ? ORDER BY name",
      ['%Córdoba%']);
    expect(r1.map((r: any) => r.name)).to.deep.equal(['p1.jpg']);
    const r2 = await conn.query(
      "SELECT name FROM media_entity WHERE metadataPositionDataCity LIKE ? ORDER BY name",
      ['%Cordoba%']);
    // p1 (Córdoba) does NOT match; p2/p3/p4 do (case-insensitive ASCII LIKE).
    expect(r2.map((r: any) => r.name)).to.deep.equal(['p2.jpg', 'p3.jpg', 'p4.jpg']);
  });

  it('with unaccent on both sides: ALL four Cordoba variants match either query', async () => {
    const conn = await SQLConnection.getConnection();
    // What the SQL looks like when DiacriticInsensitive is ON.
    const r1 = await conn.query(
      "SELECT name FROM media_entity WHERE unaccent(metadataPositionDataCity) LIKE unaccent(?) ORDER BY name",
      ['%Córdoba%']);
    expect(r1.map((r: any) => r.name)).to.deep.equal(['p1.jpg', 'p2.jpg', 'p3.jpg', 'p4.jpg']);
    const r2 = await conn.query(
      "SELECT name FROM media_entity WHERE unaccent(metadataPositionDataCity) LIKE unaccent(?) ORDER BY name",
      ['%Cordoba%']);
    expect(r2.map((r: any) => r.name)).to.deep.equal(['p1.jpg', 'p2.jpg', 'p3.jpg', 'p4.jpg']);
    // Same query for an unrelated city still works.
    const r3 = await conn.query(
      "SELECT name FROM media_entity WHERE unaccent(metadataPositionDataCity) LIKE unaccent(?) ORDER BY name",
      ['%bariloche%']);
    expect(r3.map((r: any) => r.name)).to.deep.equal(['p5.jpg']);
  });

  it('works on the keywords column (matchArrayField is also wrapped)', async () => {
    await seedMedia(dirId, {name: 'k1.jpg', keywords: 'Córdoba,Family'});
    await seedMedia(dirId, {name: 'k2.jpg', keywords: 'Cordoba'});
    const conn = await SQLConnection.getConnection();
    const r = await conn.query(
      "SELECT name FROM media_entity WHERE unaccent(metadataKeywords) LIKE unaccent(?) ORDER BY name",
      ['%cordoba%']);
    expect(r.map((r: any) => r.name)).to.include.members(['k1.jpg', 'k2.jpg']);
  });
});
