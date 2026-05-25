/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import {OfflineCitiesGeocodeProvider} from '../../../../../src/backend/model/database/OfflineGeocodeProvider';

declare const before: any;

// Tests run against the bundled cities1000 SQLite DB. The DB is built by
// `cities-db/build-cities-db.js` and lives outside the test fixtures because
// it is 15 MB. If the file is missing the whole suite is skipped — pigallery2
// CI runs that build the DB unblock these tests automatically.
const CITIES_DB = path.join(__dirname, '../../../../../cities-db/cities1000.sqlite');
const describeIfDb: any = fs.existsSync(CITIES_DB) ? describe : (describe as any).skip;

describeIfDb('OfflineCitiesGeocodeProvider', () => {
    let p: OfflineCitiesGeocodeProvider;
    before(() => {
      p = new OfflineCitiesGeocodeProvider(CITIES_DB);
    });

    describe('ready / lazy init', () => {
      it('reports ready when the DB exists', () => {
        expect(p.ready()).to.equal(true);
      });
      it('returns false from isAdmin1 when called on a fresh provider with a missing DB', () => {
        const dud = new OfflineCitiesGeocodeProvider('/no/such/file.sqlite');
        expect(dud.isAdmin1('US', 'Illinois')).to.equal(false);
        expect(dud.ready()).to.equal(false);
      });
    });

    describe('isAdmin1', () => {
      it('matches a known US admin1 by name', () => {
        expect(p.isAdmin1('United States', 'Illinois')).to.equal(true);
      });
      it('matches case-insensitively', () => {
        expect(p.isAdmin1('united states', 'illinois')).to.equal(true);
      });
      it('accepts the country ISO code in place of the name', () => {
        expect(p.isAdmin1('US', 'Illinois')).to.equal(true);
      });
      it('returns false for a city that is not an admin1', () => {
        expect(p.isAdmin1('Japan', 'Sumida')).to.equal(false);
      });
      it('returns false for an unknown country', () => {
        expect(p.isAdmin1('Nowhereland', 'Anywhere')).to.equal(false);
      });
    });

    describe('geocode — forward lookup', () => {
      it('finds an exact city match', () => {
        const r = p.geocode({country: 'United Kingdom', city: 'Lancaster'});
        expect(r?.country).to.equal('United Kingdom');
        expect(r?.city).to.equal('Lancaster');
        // Two cities are named Lancaster (UK and PA); the population tiebreak
        // doesn't matter here because the country narrows it down.
        expect(r?.latitude).to.be.closeTo(54.05, 0.5);
        expect(r?.longitude).to.be.closeTo(-2.80, 0.5);
      });

      it('falls back to state when the supplied city is actually a state', () => {
        // The digiKam Places reader's depth-2 default puts state-segments
        // in the city slot — the geocoder reinterprets them as state.
        const r = p.geocode({country: 'United States', city: 'Illinois'});
        expect(r?.state).to.equal('Illinois');
        expect(r?.city).to.equal(undefined);
        expect(r?.latitude).to.be.closeTo(40.83, 1);
        expect(r?.longitude).to.be.closeTo(-88.71, 1);
      });

      it('parses "City SC" patterns into city + admin1 code', () => {
        const r = p.geocode({country: 'United States', city: 'Washington DC'});
        expect(r?.city).to.equal('Washington');
        expect(r?.state).to.equal('District of Columbia');
        expect(r?.latitude).to.be.closeTo(38.895, 0.05);
        expect(r?.longitude).to.be.closeTo(-77.036, 0.05);
      });

      it('parses "City SC" for NY too', () => {
        const r = p.geocode({country: 'United States', city: 'Brooklyn NY'});
        expect(r?.city).to.equal('Brooklyn');
        expect(r?.state).to.equal('New York');
      });

      it('breaks city ties by population (Washington → DC, not Utah)', () => {
        const r = p.geocode({country: 'United States', city: 'Washington'});
        expect(r?.state).to.equal('District of Columbia');
      });

      it('falls back to country centroid when nothing else matches', () => {
        const r = p.geocode({country: 'Argentina', city: 'Nowheresville'});
        // Country centroid lat/lon is whatever AVG(cities lat/lon) yields for
        // AR; the only guarantee is country is returned and city/state are not.
        expect(r?.country).to.equal('Argentina');
        expect(r?.city).to.equal(undefined);
      });
    });

    describe('reverse — population-weighted', () => {
      it('picks Córdoba over the closer-but-tiny Saldán for a Córdoba-metro photo', () => {
        const r = p.reverse(-31.350, -64.265);
        expect(r?.country).to.equal('Argentina');
        expect(r?.city).to.equal('Córdoba');
      });

      it('picks London over the closer-but-tiny St James\'s in central London', () => {
        const r = p.reverse(51.51, -0.13);
        expect(r?.country).to.equal('United Kingdom');
        expect(r?.city).to.equal('London');
      });

      it('returns Lancaster when the photo is already in Lancaster', () => {
        const r = p.reverse(54.0466, -2.8007);
        expect(r?.city).to.equal('Lancaster');
      });

      it('does NOT flip Sumida-ward photos to Tokyo (10× pop gap is not enough)', () => {
        // Coords near Asakusa / Sumida ward. The population weighting must
        // not be aggressive enough to override a clearly local match.
        const r = p.reverse(35.7104, 139.7984);
        expect(r?.country).to.equal('Japan');
        // Either Asakusa (nearest) or Sumida — both correct, not Tokyo.
        expect(['Asakusa', 'Sumida', 'Taito', 'Kuramae']).to.include(r?.city);
      });
    });
  });
