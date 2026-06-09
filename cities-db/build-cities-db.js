#!/usr/bin/env node
/* eslint-disable */
// Build cities1000.sqlite from GeoNames public data (CC-BY 4.0).
// Usage: node build-cities-db.js [out-path]
// Default output: ./cities1000.sqlite (sibling of this script).
//
// Inputs (downloaded if missing):
//   - https://download.geonames.org/export/dump/cities1000.zip
//   - https://download.geonames.org/export/dump/countryInfo.txt
//   - https://download.geonames.org/export/dump/admin1CodesASCII.txt
//
// Schema:
//   cities    (id INT PK, name TEXT, country_code TEXT, admin1_code TEXT,
//              lat REAL, lon REAL, population INT)
//   countries (code TEXT PK, name TEXT)
//   admin1    (country_code, admin1_code, name; PK country_code+admin1_code)

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const {execSync} = require('child_process');
const Database = require('better-sqlite3');

const HERE = __dirname;
const TMP = path.join(HERE, 'tmp');
const OUT = process.argv[2] || path.join(HERE, 'cities1000.sqlite');
const URLS = {
  cities: 'https://download.geonames.org/export/dump/cities1000.zip',
  countries: 'https://download.geonames.org/export/dump/countryInfo.txt',
  admin1: 'https://download.geonames.org/export/dump/admin1CodesASCII.txt',
};

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {headers: {'User-Agent': 'pigallery2-build'}}, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`${url} → HTTP ${res.statusCode}`));
        return;
      }
      const ws = fs.createWriteStream(dest);
      res.pipe(ws).on('finish', () => ws.close(resolve)).on('error', reject);
    });
    req.on('error', reject);
  });
}

async function ensure(file, url) {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), {recursive: true});
  console.log(`download ${url}`);
  await download(url, file);
}

function unzipCities() {
  const zipPath = path.join(TMP, 'cities1000.zip');
  const txtPath = path.join(TMP, 'cities1000.txt');
  if (fs.existsSync(txtPath)) return txtPath;
  // GeoNames uses standard zip; unzip via system tool for simplicity.
  execSync(`unzip -p "${zipPath}" cities1000.txt > "${txtPath}"`, {stdio: 'inherit'});
  return txtPath;
}

function build() {
  if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
  const db = new Database(OUT);
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.exec(`
    CREATE TABLE countries (code TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE admin1 (country_code TEXT NOT NULL, admin1_code TEXT NOT NULL,
                          name TEXT NOT NULL,
                          PRIMARY KEY (country_code, admin1_code));
    CREATE TABLE cities (id INTEGER PRIMARY KEY, name TEXT NOT NULL,
                         country_code TEXT, admin1_code TEXT,
                         lat REAL, lon REAL, population INTEGER);
    CREATE INDEX idx_cities_lat ON cities(lat);
    CREATE INDEX idx_cities_name ON cities(name);
  `);

  // Countries: lines of form ISO\tISO3\tISONum\tFips\tName\t...
  const insCtr = db.prepare('INSERT OR IGNORE INTO countries (code, name) VALUES (?, ?)');
  db.transaction(() => {
    for (const line of fs.readFileSync(path.join(TMP, 'countryInfo.txt'), 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const f = line.split('\t');
      if (f.length < 5 || !f[0] || !f[4]) continue;
      // Strip a leading definite article so the stored name matches the bare
      // denomination EXIF/folders use ("The Netherlands" → "Netherlands"). The
      // geocoder normalizes the same way at query time (geo_canon), so this
      // just keeps a freshly-built DB consistent with the deployed one.
      insCtr.run(f[0], f[4].replace(/^The\s+/, ''));
    }
  })();

  // Admin1: "CC.A1\tname\tasciiname\tgeonameid"
  const insA1 = db.prepare('INSERT OR IGNORE INTO admin1 (country_code, admin1_code, name) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (const line of fs.readFileSync(path.join(TMP, 'admin1CodesASCII.txt'), 'utf8').split('\n')) {
      if (!line) continue;
      const f = line.split('\t');
      if (f.length < 2 || !f[0]) continue;
      const [cc, a1] = f[0].split('.');
      if (!cc || !a1) continue;
      insA1.run(cc, a1, f[1]);
    }
  })();

  // Cities: 19 tab-separated fields per row — see GeoNames readme.
  const insCity = db.prepare(`INSERT OR REPLACE INTO cities
    (id, name, country_code, admin1_code, lat, lon, population)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  let count = 0;
  db.transaction(() => {
    for (const line of fs.readFileSync(path.join(TMP, 'cities1000.txt'), 'utf8').split('\n')) {
      if (!line) continue;
      const f = line.split('\t');
      // 0=id 1=name 2=ascii 3=alt 4=lat 5=lon 6=fclass 7=fcode 8=cc 9=cc2 10=admin1 14=population
      if (f.length < 15) continue;
      insCity.run(+f[0], f[1], f[8] || null, f[10] || null,
        +f[4], +f[5], +f[14] || 0);
      count++;
    }
  })();
  console.log(`inserted ${count} cities`);
  db.exec('ANALYZE');
  db.close();
  console.log(`wrote ${OUT}`);
}

(async () => {
  await ensure(path.join(TMP, 'cities1000.zip'), URLS.cities);
  await ensure(path.join(TMP, 'countryInfo.txt'), URLS.countries);
  await ensure(path.join(TMP, 'admin1CodesASCII.txt'), URLS.admin1);
  unzipCities();
  build();
})().catch(e => {
  console.error(e);
  process.exit(1);
});
