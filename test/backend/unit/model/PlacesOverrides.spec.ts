/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {PlacesOverrides} from '../../../../src/backend/model/PlacesOverrides';
import {ProjectPath} from '../../../../src/backend/ProjectPath';

declare const beforeEach: any;
declare const afterEach: any;

describe('PlacesOverrides', () => {
  let tmpDir: string;
  let savedExtensionFolder: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'places-overrides-'));
    // PlacesOverrides derives the file location from path.dirname(ExtensionFolder).
    // Faking ExtensionFolder = <tmpDir>/extensions makes the config folder = <tmpDir>.
    savedExtensionFolder = ProjectPath.ExtensionFolder;
    ProjectPath.ExtensionFolder = path.join(tmpDir, 'extensions');
    PlacesOverrides.reset();
  });

  afterEach(() => {
    ProjectPath.ExtensionFolder = savedExtensionFolder;
    PlacesOverrides.reset();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  const writeOverrides = (obj: any) =>
    fs.writeFileSync(path.join(tmpDir, 'places_overrides.json'), JSON.stringify(obj));

  it('returns undefined when file is absent (no error, no log)', () => {
    expect(PlacesOverrides.get().lookup('Places/Anything')).to.equal(undefined);
    expect(PlacesOverrides.get().size()).to.equal(0);
  });

  it('loads valid entries and looks them up by exact path', () => {
    writeOverrides({
      'Places/Argentina': {lat: -31.43, lon: -64.20},
      'Places/United States/New Jersey/Rutgers': {lat: 40.50, lon: -74.45},
      'Places/Argentina/Córdoba/Villa Allende/Casa del Abuel (Villa)': {lat: -31.43, lon: -64.20},
    });
    const o = PlacesOverrides.get();
    expect(o.size()).to.equal(3);
    expect(o.lookup('Places/Argentina')).to.deep.equal({lat: -31.43, lon: -64.20});
    expect(o.lookup('Places/United States/New Jersey/Rutgers')).to.deep.equal({lat: 40.50, lon: -74.45});
    expect(o.lookup('Places/Argentina/Córdoba/Villa Allende/Casa del Abuel (Villa)'))
      .to.deep.equal({lat: -31.43, lon: -64.20});
  });

  it('is case-sensitive on the path key', () => {
    writeOverrides({'Places/Argentina': {lat: -31, lon: -64}});
    expect(PlacesOverrides.get().lookup('places/argentina')).to.equal(undefined);
    expect(PlacesOverrides.get().lookup('Places/argentina')).to.equal(undefined);
    expect(PlacesOverrides.get().lookup('Places/Argentina')).to.not.equal(undefined);
  });

  it('skips invalid entries but keeps valid siblings', () => {
    writeOverrides({
      'Places/Good': {lat: 1, lon: 2},
      'NoPlacesPrefix': {lat: 3, lon: 4},     // bad key
      'Places/Bad1': {lat: 'NaN', lon: 1},     // bad value type
      'Places/Bad2': {lat: 1},                 // missing lon
      'Places/Bad3': null,                     // null value
      'Places/Bad4': {lat: Infinity, lon: 0},  // non-finite
      'Places/AlsoGood': {lat: 5, lon: 6},
    });
    const o = PlacesOverrides.get();
    expect(o.size()).to.equal(2);
    expect(o.lookup('Places/Good')).to.deep.equal({lat: 1, lon: 2});
    expect(o.lookup('Places/AlsoGood')).to.deep.equal({lat: 5, lon: 6});
    expect(o.lookup('NoPlacesPrefix')).to.equal(undefined);
    expect(o.lookup('Places/Bad1')).to.equal(undefined);
  });

  it('tolerates malformed JSON (no crash, no entries)', () => {
    fs.writeFileSync(path.join(tmpDir, 'places_overrides.json'), 'not json {');
    expect(PlacesOverrides.get().lookup('Places/X')).to.equal(undefined);
    expect(PlacesOverrides.get().size()).to.equal(0);
  });

  it('reloads when the file mtime changes', async () => {
    writeOverrides({'Places/V1': {lat: 1, lon: 2}});
    expect(PlacesOverrides.get().lookup('Places/V1')).to.deep.equal({lat: 1, lon: 2});
    expect(PlacesOverrides.get().lookup('Places/V2')).to.equal(undefined);
    // Bump mtime forward so the cache invalidates.
    await new Promise(r => setTimeout(r, 50));
    fs.utimesSync(path.join(tmpDir, 'places_overrides.json'), new Date(), new Date(Date.now() + 1000));
    writeOverrides({'Places/V2': {lat: 3, lon: 4}});
    expect(PlacesOverrides.get().lookup('Places/V1')).to.equal(undefined);
    expect(PlacesOverrides.get().lookup('Places/V2')).to.deep.equal({lat: 3, lon: 4});
  });

  it('clears entries when the file is deleted', () => {
    writeOverrides({'Places/X': {lat: 1, lon: 2}});
    expect(PlacesOverrides.get().size()).to.equal(1);
    fs.unlinkSync(path.join(tmpDir, 'places_overrides.json'));
    expect(PlacesOverrides.get().lookup('Places/X')).to.equal(undefined);
    expect(PlacesOverrides.get().size()).to.equal(0);
  });

  it('__setForTesting bypasses file I/O', () => {
    PlacesOverrides.__setForTesting({'Places/Test/A': {lat: 9, lon: 10}});
    expect(PlacesOverrides.get().lookup('Places/Test/A')).to.deep.equal({lat: 9, lon: 10});
    // Even if a file exists, __setForTesting overrides it (mtime pinned to MAX).
    writeOverrides({'Places/FromFile': {lat: 0, lon: 0}});
    expect(PlacesOverrides.get().lookup('Places/FromFile')).to.equal(undefined);
    expect(PlacesOverrides.get().lookup('Places/Test/A')).to.deep.equal({lat: 9, lon: 10});
  });
});
