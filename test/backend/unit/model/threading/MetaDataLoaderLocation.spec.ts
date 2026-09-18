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
    // Pin the places-overrides map to empty so tests aren't influenced by
    // a real places_overrides.json bind-mounted into the dev container.
    // Individual override-map tests below override this with their own
    // __setForTesting call.
    const {PlacesOverrides} = require('../../../../../src/backend/model/PlacesOverrides');
    PlacesOverrides.__setForTesting({});
  });

  afterEach(() => {
    Config.Indexing.PhotoLocation.DigikamPlacesTagEnabled = savedDigikam;
    Config.Indexing.PhotoLocation.ReverseGeocodeEnabled = savedReverse;
    const {PlacesOverrides} = require('../../../../../src/backend/model/PlacesOverrides');
    PlacesOverrides.reset();
  });

  describe('baseline (digiKam tag reader + reverse-geocode disabled)', () => {
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

  describe('digiKam Places/... tag reader', () => {
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

    it('fx-shinjuku-post-sync — IPTC values win; the tag reader does not overwrite', () => {
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

    it('falls back to lr:hierarchicalSubject when digiKam:TagsList absent', () => {
      // Lowercase 'h'. exifr returns XMP property names verbatim and the
      // Lightroom schema defines lr:hierarchicalSubject, so this is the only
      // spelling that exists in a real sidecar.
      const md = callMapToponyms({
        lr: {hierarchicalSubject: ['Places|Japan|Sumida']},
      });
      expect(md.positionData).to.deep.equal({country: 'Japan', city: 'Sumida'});
    });

    it('does NOT read the capitalised lr:HierarchicalSubject', () => {
      // Pins the fix. The collector used to read the capitalised spelling, which
      // exifr never emits, so the fallback silently did nothing for any library
      // tagged only in Lightroom. This test is what keeps the typo from coming
      // back — it came from a table in the feature's own design doc once already.
      const md = callMapToponyms({
        lr: {HierarchicalSubject: ['Places|Japan|Sumida']},
      });
      expect(md.positionData).to.equal(undefined);
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

  describe('digiKam tag reader + Iptc4xmpExt interaction', () => {
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

  describe('digiKam tag reader: edge cases', () => {
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

    it('falls back to city slot when no geocoder provider is registered', () => {
      // Without a provider, isAdmin1 cannot be consulted — depth-2 defaults
      // to the city slot (digiKam's own metadata-mode behaviour).
      GeocodeProviderRegistry.reset();
      const md = callMapToponyms({
        digiKam: {TagsList: ['Places/United States/Illinois']},
      });
      expect(md.positionData).to.deep.equal({
        country: 'United States',
        city: 'Illinois',
      });
    });

    it('picks the lexicographically-smallest path among same-depth ties (deterministic)', () => {
      // Both paths have depth 3 — without a tie-break the choice would depend
      // on input order. Reordering the inputs must not change the output.
      const inputA = ['Places/A/X/Y', 'Places/A/B/C'];
      const inputB = ['Places/A/B/C', 'Places/A/X/Y'];
      const mdA = callMapToponyms({digiKam: {TagsList: inputA}});
      const mdB = callMapToponyms({digiKam: {TagsList: inputB}});
      expect(mdA.positionData).to.deep.equal(mdB.positionData);
      // Lex-smallest of (A/B/C, A/X/Y) is A/B/C.
      expect(mdA.positionData).to.deep.equal({country: 'A', state: 'B', city: 'C'});
    });
  });

  describe('places_overrides.json — manual leaf coords', () => {
    const {PlacesOverrides} = require('../../../../../src/backend/model/PlacesOverrides');

    beforeEach(() => {
      Config.Indexing.PhotoLocation.DigikamPlacesTagEnabled = true;
      PlacesOverrides.reset();
    });

    afterEach(() => {
      PlacesOverrides.reset();
    });

    it('pins GPS to the override when the longest Places path matches exactly', () => {
      PlacesOverrides.__setForTesting({
        'Places/Argentina/Córdoba/Villa Allende/Casa del Abuel (Villa)':
          {lat: -31.4399572, lon: -64.2025942},
      });
      const md = callMapToponyms({
        digiKam: {TagsList: ['Places/Argentina/Córdoba/Villa Allende/Casa del Abuel (Villa)']},
      });
      expect(md.positionData?.GPSData?.latitude).to.equal(-31.439957);
      expect(md.positionData?.GPSData?.longitude).to.equal(-64.202594);
      // City slot remains the depth-≥4 result (leaf dropped) — override
      // does NOT rewrite the city for position-search consistency.
      expect(md.positionData?.country).to.equal('Argentina');
      expect(md.positionData?.state).to.equal('Córdoba');
      expect(md.positionData?.city).to.equal('Villa Allende');
    });

    it('does not match a shorter Places path when the photo has a longer one', () => {
      // Override for Places/Argentina; photo tagged Places/Argentina/Buenos Aires.
      // Longest path is depth-2 → no exact match → no GPS pin.
      PlacesOverrides.__setForTesting({
        'Places/Argentina': {lat: -38, lon: -64},
      });
      const md = callMapToponyms({
        digiKam: {TagsList: ['Places/Argentina/Buenos Aires']},
      });
      expect(md.positionData?.GPSData).to.equal(undefined);
      expect(md.positionData?.country).to.equal('Argentina');
    });

    it('matches a depth-1 override when the photo is tagged at depth 1', () => {
      PlacesOverrides.__setForTesting({
        'Places/Argentina': {lat: -31.43, lon: -64.20},
      });
      const md = callMapToponyms({
        digiKam: {TagsList: ['Places/Argentina']},
      });
      expect(md.positionData?.GPSData?.latitude).to.equal(-31.43);
      expect(md.positionData?.GPSData?.longitude).to.equal(-64.20);
    });

    it('does not overwrite an existing GPS (soft override only)', () => {
      PlacesOverrides.__setForTesting({
        'Places/A/B/C/Pinned': {lat: 10, lon: 20},
      });
      // Photo already has GPS from EXIF — override must not touch it.
      const md: PhotoMetadata = {size: {width: 1, height: 1}, creationDate: 0, fileSize: 0};
      md.positionData = {GPSData: {latitude: 50, longitude: 60}};
      (MetadataLoader as any).mapToponyms(md, {
        digiKam: {TagsList: ['Places/A/B/C/Pinned']},
      });
      expect(md.positionData.GPSData?.latitude).to.equal(50);
      expect(md.positionData.GPSData?.longitude).to.equal(60);
    });

    it('is silent when DigikamPlacesTagEnabled is off', () => {
      Config.Indexing.PhotoLocation.DigikamPlacesTagEnabled = false;
      PlacesOverrides.__setForTesting({
        'Places/Argentina': {lat: -31.43, lon: -64.20},
      });
      const md = callMapToponyms({
        digiKam: {TagsList: ['Places/Argentina']},
      });
      expect(md.positionData?.GPSData).to.equal(undefined);
      // The tag reader didn't run either — country slot stays empty.
      expect(md.positionData?.country).to.equal(undefined);
    });
  });

  describe('reverse-geocode: regression — provider returns garbage', () => {
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

  describe('offline reverse-geocode (GPS → text)', () => {
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
