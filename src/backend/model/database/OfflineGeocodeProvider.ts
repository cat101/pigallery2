import * as fs from 'fs';
import {Logger} from '../../Logger';
import {GPSMetadata} from '../../../common/entities/PhotoDTO';

const LOG_TAG = '[OfflineGeocodeProvider]';

export interface GeocodeResult {
  country?: string;
  state?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
}

export interface GeocodeProvider {
  // `fullPath` is purely informational — included in any log line the provider
  // emits when a heuristic kicks in, so operators can trace per-photo decisions.
  reverse(lat: number, lon: number, fullPath?: string): GeocodeResult | undefined;
  geocode(query: { country?: string; state?: string; city?: string }, fullPath?: string): GeocodeResult | undefined;
  // True when `name` is a known admin1 (state/province) of `country`.
  // Used by the digiKam Places tag reader to disambiguate depth-2 tags like
  // `Places/US/Illinois` where the second segment is actually a state, not
  // the city the depth-2 city default would otherwise pick.
  isAdmin1(country: string, name: string): boolean;
  ready(): boolean;
}

// Lazily-initialised, SQLite-backed reverse+forward geocoder over the bundled
// GeoNames cities database. Build the DB out-of-band via build-cities-db.js
// (see Dockerfile). If the DB is absent the provider stays inert — callers
// should check `ready()` before relying on a result.
export class OfflineCitiesGeocodeProvider implements GeocodeProvider {
  private db: any = null;
  private reverseStmt: any = null;
  private cityForwardStmt: any = null;
  private stateForwardStmt: any = null;
  private countryForwardStmt: any = null;
  private admin1ExistsStmt: any = null;
  private cityByAdmin1CodeStmt: any = null;
  private reverseWideStmt: any = null;
  private initTried = false;

  constructor(private readonly dbPath: string) {
  }

  ready(): boolean {
    this.lazyInit();
    return !!this.db;
  }

  private lazyInit(): void {
    if (this.initTried) return;
    this.initTried = true;
    if (!fs.existsSync(this.dbPath)) {
      Logger.warn(LOG_TAG, `Cities database not found at ${this.dbPath}; offline geocoding disabled.`);
      return;
    }
    try {
      const Database = require('better-sqlite3');
      this.db = new Database(this.dbPath, {readonly: true, fileMustExist: true});
      this.db.pragma('journal_mode = OFF');
      this.db.pragma('synchronous = OFF');
      this.prepareStatements();
      Logger.info(LOG_TAG, `Loaded cities database from ${this.dbPath}`);
    } catch (e) {
      Logger.error(LOG_TAG, `Failed to open cities database: ${e}`);
      this.db = null;
    }
  }

  private prepareStatements(): void {
    // Reverse-geocode score = distance² / sqrt(population). Lower is better.
    // Why: pure "nearest" returns tiny suburbs whose centroids happen to sit
    // 1-3 km closer to a metro-edge photo than the dominant city does
    // (e.g. Saldán, pop 2k, beating Córdoba, pop 2.1M, on a photo at the
    // Córdoba-metro fringe). The sqrt(pop) weighting lets a million-people
    // city eclipse a 2 k-people suburb that is only a few km closer, while
    // still letting an exact-coordinate small town win (its distance is ~0).
    // The 1000x population gap drowns the small distance differences for the
    // suburb-vs-metro case while leaving Lancaster, Villa Allende, etc.
    // unchanged. Pre-filter to a ±1° lat window for a fast index scan.
    this.reverseStmt = this.db.prepare(`
      SELECT c.name AS city, c.lat AS lat, c.lon AS lon,
             ctr.name AS country, a.name AS state
      FROM cities c
      LEFT JOIN countries ctr ON ctr.code = c.country_code
      LEFT JOIN admin1 a ON a.country_code = c.country_code AND a.admin1_code = c.admin1_code
      WHERE c.lat BETWEEN :latMin AND :latMax
      ORDER BY (
        ((c.lat - :lat) * (c.lat - :lat)
        + (c.lon - :lon) * (c.lon - :lon) * :cosLatSq)
        / sqrt(MAX(c.population, 0) + 1.0)
      ) ASC
      LIMIT 1
    `);
    this.cityForwardStmt = this.db.prepare(`
      SELECT c.name AS city, c.lat AS lat, c.lon AS lon,
             ctr.name AS country, a.name AS state
      FROM cities c
      LEFT JOIN countries ctr ON ctr.code = c.country_code
      LEFT JOIN admin1 a ON a.country_code = c.country_code AND a.admin1_code = c.admin1_code
      WHERE c.name = :city COLLATE NOCASE
        AND (:country IS NULL OR ctr.name = :country COLLATE NOCASE OR c.country_code = :country COLLATE NOCASE)
      ORDER BY c.population DESC
      LIMIT 1
    `);
    this.stateForwardStmt = this.db.prepare(`
      SELECT AVG(c.lat) AS lat, AVG(c.lon) AS lon,
             ctr.name AS country, a.name AS state
      FROM cities c
      LEFT JOIN countries ctr ON ctr.code = c.country_code
      LEFT JOIN admin1 a ON a.country_code = c.country_code AND a.admin1_code = c.admin1_code
      WHERE a.name = :state COLLATE NOCASE
        AND (:country IS NULL OR ctr.name = :country COLLATE NOCASE OR c.country_code = :country COLLATE NOCASE)
      GROUP BY ctr.name, a.name
      ORDER BY COUNT(*) DESC
      LIMIT 1
    `);
    this.countryForwardStmt = this.db.prepare(`
      SELECT AVG(c.lat) AS lat, AVG(c.lon) AS lon,
             ctr.name AS country
      FROM cities c
      LEFT JOIN countries ctr ON ctr.code = c.country_code
      WHERE ctr.name = :country COLLATE NOCASE OR c.country_code = :country COLLATE NOCASE
      GROUP BY ctr.name
      LIMIT 1
    `);
    // True if `name` is a known admin1 of `country` (by name or ISO code).
    // Used by the digiKam Places tag reader's depth-2 disambiguation
    // (state vs. city).
    this.admin1ExistsStmt = this.db.prepare(`
      SELECT 1 FROM admin1 a
      LEFT JOIN countries ctr ON ctr.code = a.country_code
      WHERE a.name = :name COLLATE NOCASE
        AND (ctr.name = :country COLLATE NOCASE OR a.country_code = :country COLLATE NOCASE)
      LIMIT 1
    `);
    // City name within a specific admin1 (by code) and country (by name or
    // code). Used by the forward geocoder to resolve "City SC" patterns like
    // "Washington DC" or "Brooklyn NY" — where the trailing token is the
    // admin1 code of the country.
    this.cityByAdmin1CodeStmt = this.db.prepare(`
      SELECT c.name AS city, c.lat AS lat, c.lon AS lon,
             ctr.name AS country, a.name AS state
      FROM cities c
      LEFT JOIN countries ctr ON ctr.code = c.country_code
      LEFT JOIN admin1 a ON a.country_code = c.country_code AND a.admin1_code = c.admin1_code
      WHERE c.name = :city COLLATE NOCASE
        AND c.admin1_code = :admin1Code COLLATE NOCASE
        AND (ctr.name = :country COLLATE NOCASE OR c.country_code = :country COLLATE NOCASE)
      ORDER BY c.population DESC
      LIMIT 1
    `);
    // Fallback used when the ±1° lat window misses (oceans, polar coords).
    // Same ranking formula as reverseStmt but with no lat pre-filter, so it
    // does a full-table scan; rare path that should not happen for any
    // photo with sensible coords.
    this.reverseWideStmt = this.db.prepare(`
      SELECT c.name AS city, c.lat AS lat, c.lon AS lon,
             ctr.name AS country, a.name AS state
      FROM cities c
      LEFT JOIN countries ctr ON ctr.code = c.country_code
      LEFT JOIN admin1 a ON a.country_code = c.country_code AND a.admin1_code = c.admin1_code
      ORDER BY (
        ((c.lat - :lat) * (c.lat - :lat)
        + (c.lon - :lon) * (c.lon - :lon) * :cosLatSq)
        / sqrt(MAX(c.population, 0) + 1.0)
      ) ASC
      LIMIT 1
    `);
  }

  isAdmin1(country: string, name: string): boolean {
    this.lazyInit();
    if (!this.db || !country || !name) return false;
    try {
      return !!this.admin1ExistsStmt.get({country, name});
    } catch (e) {
      Logger.silly(LOG_TAG, 'isAdmin1 failed: ' + e);
      return false;
    }
  }

  reverse(lat: number, lon: number, fullPath?: string): GeocodeResult | undefined {
    this.lazyInit();
    if (!this.db) return undefined;
    const cosLat = Math.cos(lat * Math.PI / 180);
    try {
      const row = this.reverseStmt.get({
        lat, lon,
        latMin: lat - 1, latMax: lat + 1,
        cosLatSq: cosLat * cosLat,
      });
      if (!row) {
        Logger.warn('[ReverseGeocode]',
          `${fullPath ?? '<unknown>'} — (${lat},${lon}) outside dense lat window; full-table scan`);
        const wide = this.reverseWideStmt.get({lat, lon, cosLatSq: cosLat * cosLat});
        return wide ? this.toResult(wide) : undefined;
      }
      return this.toResult(row);
    } catch (e) {
      Logger.debug('[ReverseGeocode]', `${fullPath ?? '<unknown>'} — reverse failed: ${e}`);
      return undefined;
    }
  }

  geocode(query: { country?: string; state?: string; city?: string }, fullPath?: string): GeocodeResult | undefined {
    this.lazyInit();
    if (!this.db) return undefined;
    const tripleStr = `${query.country ?? '*'}/${query.state ?? '*'}/${query.city ?? '*'}`;
    try {
      if (query.city) {
        const row = this.cityForwardStmt.get({
          city: query.city,
          country: query.country ?? null,
        });
        if (row) return this.toResult(row);
        // The digiKam Places reader's depth-2 default puts the second tag
        // segment into `city`, but some libraries tag `Places/Country/State`
        // (state at depth-2). Try the same value as a state before giving up
        // on a finer-than-country lookup.
        const asState = this.stateForwardStmt.get({
          state: query.city,
          country: query.country ?? null,
        });
        if (asState) {
          Logger.debug('[ReverseGeocode]',
            `${fullPath ?? '<unknown>'} — '${query.city}' not a city in ${query.country ?? '*'}; matched as state '${query.city}'`);
          return this.toResult(asState);
        }
        // Common US-style "City SC" naming where SC is a 2- or 3-letter
        // admin1 code (e.g. "Washington DC", "Brooklyn NY"). The leading
        // segment is the city name, the trailing token is an admin1 code in
        // the country. Looking it up that way resolves "Washington DC" to
        // Washington in DC admin1 (pop 689k) instead of falling all the
        // way through to the US country centroid.
        const m = query.city.match(/^(.+?)\s+([A-Za-z]{2,3})$/);
        if (m && query.country) {
          const cityCodeRow = this.cityByAdmin1CodeStmt.get({
            city: m[1],
            admin1Code: m[2].toUpperCase(),
            country: query.country,
          });
          if (cityCodeRow) {
            Logger.debug('[ReverseGeocode]',
              `${fullPath ?? '<unknown>'} — parsed '${query.city}' as 'City ${m[2].toUpperCase()}' → city=${m[1]}, admin1=${m[2].toUpperCase()}`);
            return this.toResult(cityCodeRow);
          }
        }
      }
      if (query.state) {
        const row = this.stateForwardStmt.get({
          state: query.state,
          country: query.country ?? null,
        });
        if (row) return this.toResult(row);
      }
      if (query.country) {
        const row = this.countryForwardStmt.get({country: query.country});
        if (row) {
          Logger.warn('[ReverseGeocode]',
            `${fullPath ?? '<unknown>'} — no city/state for '${tripleStr}'; falling back to ${query.country} centroid`);
          return this.toResult(row);
        }
      }
    } catch (e) {
      Logger.debug('[ReverseGeocode]', `${fullPath ?? '<unknown>'} — geocode failed: ${e}`);
    }
    return undefined;
  }

  private toResult(row: any): GeocodeResult {
    return {
      country: row.country ?? undefined,
      state: row.state ?? undefined,
      city: row.city ?? undefined,
      latitude: row.lat != null ? +row.lat : undefined,
      longitude: row.lon != null ? +row.lon : undefined,
    };
  }
}

export class GeocodeProviderRegistry {
  private static providers: Map<string, () => GeocodeProvider> = new Map();
  private static instances: Map<string, GeocodeProvider> = new Map();

  static register(key: string, factory: () => GeocodeProvider): void {
    GeocodeProviderRegistry.providers.set(key, factory);
  }

  static get(key: string): GeocodeProvider | undefined {
    if (!GeocodeProviderRegistry.instances.has(key)) {
      const factory = GeocodeProviderRegistry.providers.get(key);
      if (!factory) return undefined;
      GeocodeProviderRegistry.instances.set(key, factory());
    }
    return GeocodeProviderRegistry.instances.get(key);
  }

  static reset(): void {
    GeocodeProviderRegistry.instances.clear();
  }
}

// Helper used by the synthetic-GPS pass to round-trip a GPSMetadata into the
// geocode result type.
export function pickGPS(r: GeocodeResult | undefined): GPSMetadata | undefined {
  if (!r || r.latitude == null || r.longitude == null) return undefined;
  return {
    latitude: parseFloat(r.latitude.toFixed(6)),
    longitude: parseFloat(r.longitude.toFixed(6)),
  };
}
