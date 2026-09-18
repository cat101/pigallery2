/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from 'chai';
import {SearchManager} from '../../../../../src/backend/model/database/SearchManager';

declare const beforeEach: any;

// Focused tests for the `defaultPlaceMatchesValue` helper that decides whether
// a search term should expand to "include unlocated photos" via the
// DefaultPlace mechanism. Pure string logic, no DB needed — tested directly.
describe('SearchManager.defaultPlaceMatchesValue', () => {
  let sm: any;

  beforeEach(() => {
    sm = new SearchManager();
  });

  const call = (defaultPlace: string, value: string, fold = false) =>
    sm.defaultPlaceMatchesValue(defaultPlace, value, fold) as boolean;

  describe('case-insensitive exact-segment matching', () => {
    it('matches a single segment (country)', () => {
      expect(call('Places/Argentina/Cordoba', 'Argentina')).to.equal(true);
    });

    it('matches a single segment (city)', () => {
      expect(call('Places/Argentina/Cordoba', 'Cordoba')).to.equal(true);
    });

    it('matches case-insensitively', () => {
      expect(call('Places/Argentina/Cordoba', 'ARGENTINA')).to.equal(true);
      expect(call('Places/Argentina/Cordoba', 'cordoba')).to.equal(true);
    });

    it('matches consecutive segments joined by /', () => {
      expect(call('Places/Argentina/Cordoba', 'Argentina/Cordoba')).to.equal(true);
    });

    it('matches longer consecutive runs', () => {
      const dp = 'Places/A/B/C/D';
      expect(call(dp, 'A/B/C')).to.equal(true);
      expect(call(dp, 'B/C/D')).to.equal(true);
      expect(call(dp, 'A/B/C/D')).to.equal(true);
    });
  });

  describe('rejects everything that is not a full-segment (or run-of-segments) match', () => {
    it('does NOT match a single letter substring', () => {
      expect(call('Places/Argentina/Cordoba', 'a')).to.equal(false);
    });

    it('does NOT match a substring of a segment', () => {
      expect(call('Places/Argentina/Cordoba', 'Cord')).to.equal(false);
      expect(call('Places/Argentina/Cordoba', 'rgent')).to.equal(false);
    });

    it('does NOT match a non-consecutive run', () => {
      // Country + city skipping state — never matches.
      expect(call('Places/A/B/C', 'A/C')).to.equal(false);
    });

    it('does NOT match a run with the wrong join character', () => {
      expect(call('Places/A/B', 'A B')).to.equal(false);
      expect(call('Places/A/B', 'A.B')).to.equal(false);
    });

    it('does NOT match an empty string', () => {
      expect(call('Places/Argentina', '')).to.equal(false);
    });

    it('does NOT match the literal Places prefix', () => {
      // The Places segment is stripped before matching — it cannot be the
      // search term that triggers expansion.
      expect(call('Places/Argentina', 'Places')).to.equal(false);
      expect(call('Places/Argentina', 'Places/Argentina')).to.equal(false);
    });
  });

  describe('diacritic folding (when enabled)', () => {
    it('matches ASCII against an accented default when fold=true', () => {
      expect(call('Places/Argentina/Córdoba', 'Cordoba', true)).to.equal(true);
    });

    it('matches accented against ASCII default when fold=true', () => {
      expect(call('Places/Argentina/Cordoba', 'Córdoba', true)).to.equal(true);
    });

    it('folds across multi-segment runs too', () => {
      expect(call('Places/Argentina/Córdoba', 'argentina/cordoba', true)).to.equal(true);
    });

    it('without fold, accented and unaccented variants do NOT match', () => {
      expect(call('Places/Argentina/Córdoba', 'Cordoba', false)).to.equal(false);
      expect(call('Places/Argentina/Cordoba', 'Córdoba', false)).to.equal(false);
    });
  });

  describe('edge cases', () => {
    it('handles repeated segments by matching at any position', () => {
      // 'A' appears twice; either position is fine since we only need ANY
      // consecutive run to equal the input.
      expect(call('Places/A/B/A', 'A')).to.equal(true);
      expect(call('Places/A/B/A', 'B/A')).to.equal(true);
    });

    it('tolerates a default that already includes a trailing slash', () => {
      expect(call('Places/Argentina/', 'Argentina')).to.equal(true);
    });

    it('tolerates a default without the Places prefix', () => {
      // Some users might omit the prefix. The filter only strips literal
      // "Places" segments, so 'Argentina/Cordoba' is treated as two segments.
      expect(call('Argentina/Cordoba', 'Argentina')).to.equal(true);
      expect(call('Argentina/Cordoba', 'Cordoba')).to.equal(true);
    });
  });
});
