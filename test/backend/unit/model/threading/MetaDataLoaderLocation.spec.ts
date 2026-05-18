/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from 'chai';
import {MetadataLoader} from '../../../../../src/backend/model/fileaccess/MetadataLoader';
import {Config} from '../../../../../src/common/config/private/Config';
import {PhotoMetadata} from '../../../../../src/common/entities/PhotoDTO';
import {
  GeocodeProviderRegistry,
  GeocodeProvider,
  GeocodeResult,
} from '../../../../../src/backend/model/database/OfflineGeocodeProvider';

declare const before: any;
declare const beforeEach: any;
declare const afterEach: any;

// Access the private `mapToponyms` for unit-level tests. Going via `as any`
// is the lightest hook: it avoids changing visibility on a load-bearing
// production method just to make the tests work.
function callMapToponyms(exif: any): PhotoMetadata {
  const md: PhotoMetadata = {size: {width: 1, height: 1}, creationDate: 0, fileSize: 0};
  (MetadataLoader as any).mapToponyms(md, exif);
  return md;
}

describe('MetadataLoader.mapToponyms — location search features', () => {
  before(() => {
    Config.loadSync();
  });

  let savedDigikam: boolean;
  let savedReverse: boolean;

  beforeEach(() => {
    savedDigikam = Config.Indexing.PhotoLocation.DigikamPlacesTagEnabled;
    savedReverse = Config.Indexing.PhotoLocation.ReverseGeocodeEnabled;
    Config.Indexing.PhotoLocation.DigikamPlacesTagEnabled = false;
    Config.Indexing.PhotoLocation.ReverseGeocodeEnabled = false;
  });

  afterEach(() => {
    Config.Indexing.PhotoLocation.DigikamPlacesTagEnabled = savedDigikam;
    Config.Indexing.PhotoLocation.ReverseGeocodeEnabled = savedReverse;
  });

  describe('baseline (no F1/F2 enabled)', () => {
    it('keeps existing IPTC IIM + XMP-photoshop behavior', () => {
      const md = callMapToponyms({
        iptc: {Country: 'Japan', City: 'Shinjuku'},
        photoshop: {Country: 'JapanXMP', City: 'ShinjukuXMP'},
      });
      expect(md.positionData).to.deep.equal({country: 'Japan', city: 'Shinjuku'});
    });

    it('falls back to XMP-photoshop when IPTC absent', () => {
      const md = callMapToponyms({photoshop: {Country: 'Japan', City: 'Shinjuku'}});
      expect(md.positionData).to.deep.equal({country: 'Japan', city: 'Shinjuku'});
    });

    it('reads Iptc4xmpExt namespace as a third fallback (always on)', () => {
      const md = callMapToponyms({
        Iptc4xmpExt: {
          CountryName: 'Germany',
          ProvinceState: 'Berlin',
          City: 'Mitte',
        },
      });
      expect(md.positionData).to.deep.equal({
        country: 'Germany',
        state: 'Berlin',
        city: 'Mitte',
      });
    });

    it('returns no positionData when all sources are empty', () => {
      const md = callMapToponyms({});
      expect(md.positionData).to.equal(undefined);
    });

    it('does NOT read digiKam Places when the flag is off', () => {
      const md = callMapToponyms({
        digiKam: {TagsList: ['Places/Japan/Shinjuku']},
      });
      expect(md.positionData).to.equal(undefined);
    });
  });

  describe('F1: digiKam Places/... tag reader', () => {
    beforeEach(() => {
      Config.Indexing.PhotoLocation.DigikamPlacesTagEnabled = true;
    });

    it('fx-lancaster-2004 — depth-1: country only', () => {
      const md = callMapToponyms({
        digiKam: {TagsList: ['Places/United Kingdom']},
      });
      expect(md.positionData).to.deep.equal({country: 'United Kingdom'});
    });

    it('fx-london-2018 — depth-3: country + state + city; longest path wins', () => {
      const md = callMapToponyms({
        digiKam: {
          TagsList: [
            'Places/United Kingdom/England',
            'Places/United Kingdom/England/City of London',
            'Places/United Kingdom',
            'About/ASDC',
          ],
        },
      });
      expect(md.positionData).to.deep.equal({
        country: 'United Kingdom',
        state: 'England',
        city: 'City of London',
      });
    });

    it('fx-sumida-2026 — depth-2: country + city (state stays empty when no provider)', () => {
      const md = callMapToponyms({
        digiKam: {
          TagsList: ['Places/Japan', 'Places/Japan/Sumida', 'People/Rosario Cuenca'],
        },
      });
      expect(md.positionData).to.deep.equal({country: 'Japan', city: 'Sumida'});
    });

    it('depth-2: when the geocoder recognises the second segment as an admin1, slot it into state', () => {
      const KEY = 'offline-cities1000';
      GeocodeProviderRegistry.reset();
      GeocodeProviderRegistry.register(KEY, () => ({
        ready: () => true,
        reverse: () => undefined,
        geocode: () => undefined,
        isAdmin1: (country, name) =>
          country === 'United States' && name === 'Illinois',
      }));
      try {
        const md = callMapToponyms({
          digiKam: {TagsList: ['Places/United States/Illinois']},
        });
        expect(md.positionData).to.deep.equal({
          country: 'United States',
          state: 'Illinois',
        });
      } finally {
        GeocodeProviderRegistry.reset();
      }
    });

    it('depth-2: when the geocoder rejects the second segment, slot it into city', () => {
      const KEY = 'offline-cities1000';
      GeocodeProviderRegistry.reset();
      GeocodeProviderRegistry.register(KEY, () => ({
        ready: () => true,
        reverse: () => undefined,
        geocode: () => undefined,
        isAdmin1: () => false,
      }));
      try {
        const md = callMapToponyms({
          digiKam: {TagsList: ['Places/Japan/Sumida']},
        });
        expect(md.positionData).to.deep.equal({country: 'Japan', city: 'Sumida'});
      } finally {
        GeocodeProviderRegistry.reset();
      }
    });

    it('fx-shinjuku-post-sync — IPTC values win; F1 does not overwrite', () => {
      const md = callMapToponyms({
        iptc: {Country: 'Japan', City: 'Shinjuku'},
        photoshop: {Country: 'Japan', City: 'Shinjuku'},
        digiKam: {TagsList: ['Places/Japan/Shinjuku', 'Places/Japan']},
      });
      expect(md.positionData).to.deep.equal({country: 'Japan', city: 'Shinjuku'});
    });

    it('fx-koifman-1980 — depth-4: leaf "Casa del Abuel (Villa)" dropped', () => {
      const md = callMapToponyms({
        digiKam: {
          TagsList: ['Places/Argentina/Córdoba/Villa Allende/Casa del Abuel (Villa)'],
        },
      });
      expect(md.positionData).to.deep.equal({
        country: 'Argentina',
        state: 'Córdoba',
        city: 'Villa Allende',
      });
    });

    it('fx-xbmc-3-leaf — depth-4 from a single full path', () => {
      const md = callMapToponyms({
        digiKam: {TagsList: ['Places/Argentina/Córdoba/Cordoba/Betania']},
      });
      expect(md.positionData).to.deep.equal({
        country: 'Argentina',
        state: 'Córdoba',
        city: 'Cordoba',
      });
    });

    it('fx-xbmc-2-all — depth-4 from four entries → longest-path-wins gives same result', () => {
      const md = callMapToponyms({
        digiKam: {
          TagsList: [
            'Places/Argentina',
            'Places/Argentina/Córdoba',
            'Places/Argentina/Córdoba/Cordoba',
            'Places/Argentina/Córdoba/Cordoba/Betania',
          ],
        },
      });
      expect(md.positionData).to.deep.equal({
        country: 'Argentina',
        state: 'Córdoba',
        city: 'Cordoba',
      });
    });

    it('falls back to lr:HierarchicalSubject when digiKam:TagsList absent', () => {
      const md = callMapToponyms({
        lr: {HierarchicalSubject: ['Places|Japan|Sumida']},
      });
      expect(md.positionData).to.deep.equal({country: 'Japan', city: 'Sumida'});
    });

    it('ignores non-Places hierarchical entries', () => {
      const md = callMapToponyms({
        digiKam: {TagsList: ['About/ASDC', 'People/Someone']},
      });
      expect(md.positionData).to.equal(undefined);
    });

    it('only fills empty fields — never overwrites file-authored values', () => {
      const md = callMapToponyms({
        photoshop: {Country: 'PhotoshopCountry'},
        digiKam: {TagsList: ['Places/DigikamCountry/DigikamState/DigikamCity']},
      });
      expect(md.positionData).to.deep.equal({
        country: 'PhotoshopCountry',
        state: 'DigikamState',
        city: 'DigikamCity',
      });
    });
  });

  describe('F1 + Iptc4xmpExt interaction', () => {
    beforeEach(() => {
      Config.Indexing.PhotoLocation.DigikamPlacesTagEnabled = true;
    });

    it('Iptc4xmpExt is preferred over digiKam (Iptc4xmpExt is more authoritative)', () => {
      const md = callMapToponyms({
        Iptc4xmpExt: {CountryName: 'Japan', City: 'Shinjuku'},
        digiKam: {TagsList: ['Places/JapanFromTag/ShinjukuFromTag']},
      });
      expect(md.positionData).to.deep.equal({country: 'Japan', city: 'Shinjuku'});
    });
  });

  describe('F1: edge cases', () => {
    beforeEach(() => {
      Config.Indexing.PhotoLocation.DigikamPlacesTagEnabled = true;
    });

    it('ignores empty path segments (malformed depth-3 like Places/US//Chicago)', () => {
      // The split-and-filter logic should treat `Places/US//Chicago` as a
      // depth-2 path Places/US/Chicago, not crash.
      const md = callMapToponyms({
        digiKam: {TagsList: ['Places/United States//Chicago']},
      });
      expect(md.positionData?.country).to.equal('United States');
      // Chicago is not a known admin1 → lands in city slot.
      expect(md.positionData?.city).to.equal('Chicago');
    });

    it('mixed digiKam tag trees: only Places/ entries are considered', () => {
      // The `Trips/` tag must NOT be interpreted as country=Trips.
      const md = callMapToponyms({
        digiKam: {
          TagsList: ['Trips/Greece 2002', 'Places/Greece/Athens'],
        },
      });
      expect(md.positionData?.country).to.equal('Greece');
      expect(md.positionData?.city).to.equal('Athens');
    });

    it('falls back to city slot when the geocoder provider throws from isAdmin1', () => {
      const KEY = 'offline-cities1000';
      GeocodeProviderRegistry.reset();
      GeocodeProviderRegistry.register(KEY, () => ({
        ready: () => true,
        reverse: () => undefined,
        geocode: () => undefined,
        isAdmin1: () => { throw new Error('boom'); },
      }));
      try {
        const md = callMapToponyms({
          digiKam: {TagsList: ['Places/United States/Illinois']},
        });
        // We swallow the throw and degrade to city slot.
        expect(md.positionData).to.deep.equal({
          country: 'United States',
          city: 'Illinois',
        });
      } finally {
        GeocodeProviderRegistry.reset();
      }
    });
  });

  describe('F2: regression — provider returns garbage', () => {
    const KEY = 'offline-cities1000';

    beforeEach(() => {
      GeocodeProviderRegistry.reset();
      Config.Indexing.PhotoLocation.ReverseGeocodeEnabled = true;
      (MetadataLoader as any).reverseGeocodeCache = new (require(
        '../../../../../src/common/Utils').LRU)(500);
    });

    afterEach(() => {
      GeocodeProviderRegistry.reset();
    });

    it('does not overwrite when provider returns lat/lon = NaN', () => {
      GeocodeProviderRegistry.register(KEY, () => ({
        ready: () => true,
        reverse: () => ({country: 'X', latitude: NaN, longitude: NaN}),
        geocode: () => undefined,
        isAdmin1: () => false,
      }));
      const md: PhotoMetadata = {
        size: {width: 1, height: 1}, creationDate: 0, fileSize: 0,
        positionData: {GPSData: {latitude: 35.7, longitude: 139.8}},
      };
      (MetadataLoader as any).mapToponyms(md, {});
      // GPSData stays as we supplied it; country/state/city *may* be filled
      // (the provider returned country=X) — the assertion is that GPS is
      // untouched and we don't crash.
      expect(md.positionData?.GPSData?.latitude).to.equal(35.7);
      expect(md.positionData?.GPSData?.longitude).to.equal(139.8);
    });
  });

  describe('F2: offline reverse-geocode (GPS → text)', () => {
    // The production code resolves Provider via the GeocodeProviderRegistryKey
    // map (enum → string). To inject a fake without touching that mapping,
    // register the fake under the same string key the default enum resolves to.
    const REGISTRY_KEY = 'offline-cities1000';
    let reverseCalls: Array<[number, number]>;
    let fakeResult: GeocodeResult | undefined;

    beforeEach(() => {
      reverseCalls = [];
      fakeResult = undefined;
      GeocodeProviderRegistry.reset();
      const fake: GeocodeProvider = {
        ready: () => true,
        reverse: (lat, lon) => {
          reverseCalls.push([lat, lon]);
          return fakeResult;
        },
        geocode: () => undefined,
        isAdmin1: () => false,
      };
      GeocodeProviderRegistry.register(REGISTRY_KEY, () => fake);
      Config.Indexing.PhotoLocation.ReverseGeocodeEnabled = true;
      // Reset the per-process LRU on the loader to avoid cross-test pollution.
      (MetadataLoader as any).reverseGeocodeCache = new (require(
        '../../../../../src/common/Utils').LRU)(500);
    });

    afterEach(() => {
      GeocodeProviderRegistry.reset();
    });

    it('does not call provider when GPS is absent', () => {
      callMapToponyms({});
      expect(reverseCalls.length).to.equal(0);
    });

    // Helper: build a PhotoMetadata pre-populated with GPSData the way mapGPS
    // would leave it before mapToponyms runs.
    const mdWithGPS = (lat: number, lon: number): PhotoMetadata => ({
      size: {width: 1, height: 1}, creationDate: 0, fileSize: 0,
      positionData: {GPSData: {latitude: lat, longitude: lon}},
    });

    it('does not call provider when text location is already present (IPTC)', () => {
      fakeResult = {country: 'Shouldnt', state: 'Be', city: 'Used'};
      const md = mdWithGPS(35.69, 139.69);
      (MetadataLoader as any).mapToponyms(md, {
        iptc: {Country: 'Japan', State: 'Tokyo', City: 'Shinjuku'},
      });
      expect(reverseCalls.length).to.equal(0);
      expect(md.positionData.country).to.equal('Japan');
    });

    it('fills empty fields when GPS is present but text is missing', () => {
      fakeResult = {country: 'Japan', state: 'Tokyo', city: 'Shinjuku',
                    latitude: 35.69, longitude: 139.69};
      const md = mdWithGPS(35.6896, 139.6917);
      (MetadataLoader as any).mapToponyms(md, {});
      expect(md.positionData).to.deep.equal({
        country: 'Japan', state: 'Tokyo', city: 'Shinjuku',
        GPSData: {latitude: 35.6896, longitude: 139.6917},
      });
      expect(reverseCalls.length).to.equal(1);
    });

    it('does not overwrite file-authored fields (only fills empty ones)', () => {
      fakeResult = {country: 'NopeCountry', state: 'NopeState', city: 'NopeCity'};
      const md = mdWithGPS(35.7, 139.8);
      (MetadataLoader as any).mapToponyms(md, {photoshop: {Country: 'Japan'}});
      expect(md.positionData.country).to.equal('Japan');
      expect(md.positionData.state).to.equal('NopeState');
      expect(md.positionData.city).to.equal('NopeCity');
    });

    it('does nothing when disabled', () => {
      Config.Indexing.PhotoLocation.ReverseGeocodeEnabled = false;
      fakeResult = {country: 'Japan'};
      const md = mdWithGPS(35.7, 139.8);
      (MetadataLoader as any).mapToponyms(md, {});
      expect(reverseCalls.length).to.equal(0);
      expect(md.positionData.country).to.equal(undefined);
    });

    it('caches by lat/lon rounded to ~1 km cell', () => {
      fakeResult = {country: 'Japan'};
      for (const [lat, lon] of [[35.690, 139.691], [35.691, 139.692], [35.694, 139.694]]) {
        (MetadataLoader as any).mapToponyms(mdWithGPS(lat, lon), {});
      }
      // All three round to 35.69,139.69 → one cache miss only.
      expect(reverseCalls.length).to.equal(1);
    });
  });
});
