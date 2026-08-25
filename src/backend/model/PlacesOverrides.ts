import * as fs from 'fs';
import * as path from 'path';
import {ProjectPath} from '../ProjectPath';
import {Logger} from '../Logger';

const LOG_TAG = '[PlacesOverrides]';

export interface PlaceOverride {
  lat: number;
  lon: number;
}

// User-managed JSON file mapping a full digiKam `Places/...` path to a manual
// {lat, lon} pin. Used by applyDigikamPlacesTag in MetadataLoader: when
// DigikamPlacesTagEnabled is on and a photo's longest Places path matches an
// override key (exact, case-sensitive), the override's coords are written
// into the photo's GPS slot (only when GPS is missing — soft override).
//
// File layout (sibling to config.json):
//   /app/data/config/places_overrides.json
//   {
//     "Places/Argentina":                             {"lat": -31.43, "lon": -64.20},
//     "Places/United States/New Jersey/Rutgers":      {"lat": 40.50,  "lon": -74.45},
//     "Places/Argentina/Córdoba/.../Casa del Abuel":  {"lat": -31.30, "lon": -64.30}
//   }
//
// Missing file is silently ignored (no log, no warning). Present file: one
// boot log line with count. Reload-on-mtime-change so edits during a running
// container picked up on the next call (typically next Indexing job).
export class PlacesOverrides {
  private static instance: PlacesOverrides | null = null;
  private map = new Map<string, PlaceOverride>();
  private lastMtimeMs: number | null = null;  // null = never checked; -1 = file absent
  private overridePath: string | null = null;
  private frozen = false;  // true when __setForTesting pinned the map; skips refresh

  private constructor() { /* lazy resolution of the path */ }

  static get(): PlacesOverrides {
    if (!this.instance) this.instance = new PlacesOverrides();
    return this.instance;
  }

  static reset(): void {
    this.instance = null;
  }

  // Test-only: bypass file I/O and inject the override map directly. Sets the
  // `frozen` flag so refreshIfChanged becomes a no-op until reset() is called.
  static __setForTesting(entries: Record<string, PlaceOverride>): void {
    const inst = this.get();
    inst.map.clear();
    for (const [k, v] of Object.entries(entries)) inst.map.set(k, {lat: v.lat, lon: v.lon});
    inst.frozen = true;
  }

  // Returns the override coords for an exact Places path match, or undefined.
  // The path argument must include the leading "Places/" segment, as the user
  // writes it in the JSON file. Lookups are case-sensitive.
  lookup(placesPath: string): PlaceOverride | undefined {
    this.refreshIfChanged();
    return this.map.get(placesPath);
  }

  // Internal: count of currently-loaded entries (for tests + diagnostics).
  size(): number {
    this.refreshIfChanged();
    return this.map.size;
  }

  // Internal: resolved path or null if not resolvable yet.
  filePath(): string | null {
    this.resolvePath();
    return this.overridePath;
  }

  private resolvePath(): void {
    if (this.overridePath) return;
    // Sibling to config.json. ProjectPath.ExtensionFolder is the env-overridable
    // `<configFolder>/extensions`; its parent is the config folder.
    if (!ProjectPath.ExtensionFolder) return;  // ProjectPath not init'd yet (e.g. in some tests)
    this.overridePath = path.join(path.dirname(ProjectPath.ExtensionFolder), 'places_overrides.json');
  }

  private refreshIfChanged(): void {
    if (this.frozen) return;
    this.resolvePath();
    if (!this.overridePath) return;
    let mtime: number;
    try {
      mtime = fs.statSync(this.overridePath).mtimeMs;
    } catch {
      // File missing — silent per spec.
      if (this.lastMtimeMs !== -1) {
        this.lastMtimeMs = -1;
        this.map.clear();
      }
      return;
    }
    if (mtime === this.lastMtimeMs) return;
    this.lastMtimeMs = mtime;
    this.map.clear();
    let raw: any;
    try {
      raw = JSON.parse(fs.readFileSync(this.overridePath, 'utf8'));
    } catch (e) {
      Logger.warn(LOG_TAG, `failed to parse ${this.overridePath}: ${e}`);
      return;
    }
    let parsed = 0;
    let invalid = 0;
    if (raw && typeof raw === 'object') {
      for (const [key, val] of Object.entries(raw)) {
        if (typeof key !== 'string' || !key.startsWith('Places/')) {
          invalid++;
          continue;
        }
        const v = val as any;
        if (typeof v !== 'object' || v == null
          || typeof v.lat !== 'number' || typeof v.lon !== 'number'
          || !isFinite(v.lat) || !isFinite(v.lon)) {
          invalid++;
          continue;
        }
        this.map.set(key, {lat: v.lat, lon: v.lon});
        parsed++;
      }
    } else {
      Logger.warn(LOG_TAG, `${this.overridePath} is not a JSON object; ignored`);
      return;
    }
    if (invalid > 0) {
      Logger.info(LOG_TAG, `loaded ${parsed} entries from ${this.overridePath} (${invalid} invalid)`);
    } else {
      Logger.info(LOG_TAG, `loaded ${parsed} entries from ${this.overridePath}`);
    }
  }
}
