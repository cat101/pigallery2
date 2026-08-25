import {expect} from 'chai';
import {MetadataLoader} from '../../../../src/backend/model/fileaccess/MetadataLoader';
import {AlbumManager} from '../../../../src/backend/model/database/AlbumManager';
import {Config} from '../../../../src/common/config/private/Config';
import {
  SearchQueryTypes,
  TextSearch,
  TextSearchQueryMatchTypes,
} from '../../../../src/common/entities/SearchQueryDTO';

declare const describe: any;
declare const before: any;
declare const after: any;
declare const it: any;

// Pure-logic tests for the "digiKam tag tree as albums" feature. No DB / no
// image fixtures: the ingestion is exercised by feeding a mock exif object to
// MetadataLoader.mapDigikamTagAlbums, and the album↔tag mapping helpers on
// AlbumManager are pure functions.
describe('Digikam tag-tree albums', () => {

  const setPrefixes = (enabled: boolean, tagPrefixes = '') => {
    Config.Album.digikamTagTree.enabled = enabled;
    Config.Album.digikamTagTree.tagPrefixes = tagPrefixes;
  };

  before(() => {
    Config.loadSync();
  });

  after(() => {
    setPrefixes(false, '');
  });

  // Calls the (private) static loader hook with a mock exif object and returns
  // the keywords it produced.
  const keywordsFor = (exif: any): string[] => {
    const meta: any = {};
    (MetadataLoader as any).mapDigikamTagAlbums(meta, exif);
    return meta.keywords || [];
  };

  describe('digikamAlbumPrefixes()', () => {
    it('is empty when disabled', () => {
      setPrefixes(false, 'Albums/;About/');
      expect(MetadataLoader.digikamAlbumPrefixes()).to.deep.equal([]);
    });

    it('parses, trims and strips trailing slashes when enabled', () => {
      setPrefixes(true, ' Albums/ ; About/// ;; ');
      expect(MetadataLoader.digikamAlbumPrefixes()).to.deep.equal(['Albums', 'About']);
    });
  });

  describe('mapDigikamTagAlbums() ingestion', () => {
    before(() => setPrefixes(true, 'Albums/;About/'));

    it('keeps only tags under a configured prefix, as full "/"-joined paths', () => {
      expect(keywordsFor({
        digiKam: {TagsList: ['Albums/Trips/Cuba', 'Places/Mexico/Yucatan', 'About/Headshots']}
      })).to.deep.equal(['Albums/Trips/Cuba', 'About/Headshots']);
    });

    it('reads the lr:hierarchicalSubject ("|") namespace too, de-duplicated', () => {
      expect(keywordsFor({
        digiKam: {TagsList: ['Albums/Trips/Cuba']},
        lr: {hierarchicalSubject: ['Albums|Trips|Cuba', 'About|Headshots']}
      })).to.deep.equal(['Albums/Trips/Cuba', 'About/Headshots']);
    });

    it('HTML-decodes segments (&amp; -> &)', () => {
      expect(keywordsFor({
        digiKam: {TagsList: ['Albums/Greece &amp; Turkey (2003)']}
      })).to.deep.equal(['Albums/Greece & Turkey (2003)']);
    });

    it('replaces commas with single spaces (simple-array safety)', () => {
      expect(keywordsFor({
        digiKam: {TagsList: ['Albums/Espana, Londres, Paris (2013)']}
      })).to.deep.equal(['Albums/Espana Londres Paris (2013)']);
    });

    it('ignores single-segment tags and non-prefixed tags', () => {
      expect(keywordsFor({
        digiKam: {TagsList: ['Albums', 'Other/Thing']}
      })).to.deep.equal([]);
    });

    it('adds nothing when the feature is disabled', () => {
      setPrefixes(false, 'Albums/');
      expect(keywordsFor({digiKam: {TagsList: ['Albums/Trips/Cuba']}})).to.deep.equal([]);
      setPrefixes(true, 'Albums/;About/');
    });
  });

  describe('AlbumManager tag-album helpers', () => {
    const prefixes = ['Albums', 'About'];

    it('derives root and stripped-suffix name', () => {
      expect(AlbumManager.digikamTagRoot('Albums/Trips/Cuba')).to.equal('Albums');
      expect(AlbumManager.digikamTagAlbumName('Albums/Trips/Cuba')).to.equal('Trips/Cuba');
    });

    it('builds an exact keyword query on the full path', () => {
      expect(AlbumManager.digikamTagAlbumQuery('Albums/Trips/Cuba')).to.deep.equal({
        type: SearchQueryTypes.keyword,
        matchType: TextSearchQueryMatchTypes.exact_match,
        value: 'Albums/Trips/Cuba',
      } as TextSearch);
    });

    it('recognises a generated album by its shape', () => {
      const album: any = {
        name: 'Trips/Cuba',
        searchQuery: AlbumManager.digikamTagAlbumQuery('Albums/Trips/Cuba'),
      };
      expect(AlbumManager.isDigikamTagAlbum(album, prefixes)).to.equal(true);
    });

    it('does not match manual saved searches or wrong-shaped albums', () => {
      // manual any_text search
      expect(AlbumManager.isDigikamTagAlbum(
        {name: 'My search', searchQuery: {type: SearchQueryTypes.any_text, value: 'x'}} as any,
        prefixes)).to.equal(false);
      // keyword exact, but value not under a configured prefix
      expect(AlbumManager.isDigikamTagAlbum(
        {name: 'Y', searchQuery: AlbumManager.digikamTagAlbumQuery('Other/Y')} as any,
        prefixes)).to.equal(false);
      // right query, but name isn't the stripped suffix
      expect(AlbumManager.isDigikamTagAlbum(
        {name: 'Wrong', searchQuery: AlbumManager.digikamTagAlbumQuery('Albums/Trips/Cuba')} as any,
        prefixes)).to.equal(false);
    });
  });
});
