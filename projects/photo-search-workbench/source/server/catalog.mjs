import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { compileQuery, QueryValidationError } from './query.mjs';

export const CATALOG_EXPORT_VERSION = 1;
const PHOTO_FIELDS = ['id', 'title', 'filename', 'url', 'location', 'date', 'tags', 'label', 'favorite', 'color', 'width', 'height'];
const MAX_PHOTOS = 10000;
const MAX_TAGS = 100;
const MAX_STRING_LENGTH = 300;
const MAX_FILENAME_LENGTH = 255;
const MAX_URL_LENGTH = 512;

export const catalogPhotos = [
  ['dolomites-dawn', 'Dawn over the Dolomites', 'dolomites-dawn.svg', 'Dolomites, Italy', '2024-01-18', ['mountain', 'snow', 'sunrise'], 'Landscape', false, '#e9a26f', 1200, 800],
  ['dolomites-larch', 'Larch Valley, Dolomites', 'dolomites-larch.svg', 'Dolomites, Italy', '2024-09-28', ['mountain', 'forest', 'autumn'], 'Nature', true, '#d28355', 1200, 800],
  ['dolomites-lake', 'Mirror Lake in the Dolomites', 'dolomites-lake.svg', 'Dolomites, Italy', '2024-07-05', ['mountain', 'lake', 'reflection'], 'Travel', false, '#5a90a4', 1200, 800],
  ['kyoto-grove', 'Bamboo Dawn, Kyoto', 'kyoto-grove.svg', 'Kyoto, Japan', '2023-04-09', ['forest', 'bamboo', 'sunrise'], 'Nature', false, '#679b70', 1200, 800],
  ['kyoto-lanterns', 'Lantern Street after Rain', 'kyoto-lanterns.svg', 'Kyoto, Japan', '2024-03-21', ['city', 'architecture', 'rain'], 'Architecture', true, '#bb6b62', 1200, 800],
  ['kyoto-hills', 'Blue Hills beyond Kyoto', 'kyoto-hills.svg', 'Kyoto, Japan', '2025-11-02', ['mountain', 'forest', 'mist'], 'Landscape', false, '#6c83a1', 1200, 800],
  ['algarve-caves', 'Golden Caves of Algarve', 'algarve-caves.svg', 'Algarve, Portugal', '2024-06-14', ['coast', 'beach', 'sunset'], 'Travel', true, '#e28e55', 1200, 800],
  ['algarve-cliffs', 'Cliffs at Praia da Marinha', 'algarve-cliffs.svg', 'Algarve, Portugal', '2023-08-22', ['coast', 'ocean', 'sunny'], 'Landscape', false, '#5aa4b7', 1200, 800],
  ['algarve-village', 'White Village by the Sea', 'algarve-village.svg', 'Algarve, Portugal', '2025-05-17', ['coast', 'architecture', 'city'], 'Architecture', false, '#d69c6c', 1200, 800],
  ['lofoten-ridge', 'Lofoten Winter Ridge', 'lofoten-ridge.svg', 'Lofoten, Norway', '2024-02-11', ['mountain', 'snow', 'aurora'], 'Landscape', true, '#425b91', 1200, 800],
  ['lofoten-fishing', 'Red Cabins of Reine', 'lofoten-fishing.svg', 'Lofoten, Norway', '2024-10-06', ['mountain', 'architecture', 'coast'], 'Architecture', false, '#a85b51', 1200, 800],
  ['lofoten-summer', 'Summer Fjord Light', 'lofoten-summer.svg', 'Lofoten, Norway', '2025-06-29', ['mountain', 'coast', 'forest'], 'Travel', false, '#6ca79b', 1200, 800],
  ['joshua-stars', 'Stars above Joshua Tree', 'joshua-stars.svg', 'Joshua Tree, USA', '2024-05-03', ['desert', 'night', 'stars'], 'Nature', true, '#342b55', 1200, 800],
  ['joshua-arch', 'Desert Arch at Sunset', 'joshua-arch.svg', 'Joshua Tree, USA', '2023-10-19', ['desert', 'sunset', 'rock'], 'Landscape', false, '#c36c4e', 1200, 800],
  ['joshua-cactus', 'Cactus Garden Trail', 'joshua-cactus.svg', 'Joshua Tree, USA', '2025-04-12', ['desert', 'forest', 'trail'], 'Nature', false, '#839d64', 1200, 800],
  ['alps-glacier', 'Glacier Blue, Swiss Alps', 'alps-glacier.svg', 'Swiss Alps, Switzerland', '2024-01-30', ['mountain', 'snow', 'glacier'], 'Landscape', false, '#6da6c5', 1200, 800],
  ['alps-meadow', 'Alpine Meadow in June', 'alps-meadow.svg', 'Swiss Alps, Switzerland', '2024-06-08', ['mountain', 'forest', 'meadow'], 'Nature', true, '#73a76b', 1200, 800],
  ['alps-cabin', 'Cabin under the Matterhorn', 'alps-cabin.svg', 'Swiss Alps, Switzerland', '2023-12-16', ['mountain', 'snow', 'architecture'], 'Architecture', false, '#728ca5', 1200, 800],
  ['coast-pines', 'Pine Coast at Blue Hour', 'coast-pines.svg', 'Lofoten, Norway', '2025-08-03', ['coast', 'forest', 'sunset'], 'Nature', false, '#527a86', 1200, 800],
  ['coast-boardwalk', 'Boardwalk to the Atlantic', 'coast-boardwalk.svg', 'Algarve, Portugal', '2024-09-11', ['coast', 'beach', 'sunset'], 'Travel', false, '#d69b62', 1200, 800],
  ['city-dolomite', 'Stone Village at Blue Hour', 'city-dolomite.svg', 'Dolomites, Italy', '2025-02-24', ['city', 'architecture', 'mountain'], 'Architecture', false, '#656c9a', 1200, 800],
  ['forest-mist', 'Misty Forest Path', 'forest-mist.svg', 'Kyoto, Japan', '2024-11-13', ['forest', 'mist', 'trail'], 'Nature', false, '#527b70', 1200, 800],
  ['desert-dunes', 'Rose Dunes at Dusk', 'desert-dunes.svg', 'Joshua Tree, USA', '2023-06-30', ['desert', 'sunset', 'dunes'], 'Landscape', false, '#c67569', 1200, 800],
  ['fjord-snow', 'Fjord under First Snow', 'fjord-snow.svg', 'Lofoten, Norway', '2024-12-02', ['mountain', 'snow', 'coast'], 'Travel', true, '#607fa2', 1200, 800],
];

export function photoFromRow(row) {
  return { ...row, tags: JSON.parse(row.tags) };
}

function isValidDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= daysInMonth;
}

function assertBoundedString(value, label, maximum = MAX_STRING_LENGTH) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new QueryValidationError(`${label} must be a non-empty string of ${maximum} characters or fewer`);
  }
}

function validatePhoto(photo, index) {
  if (!photo || typeof photo !== 'object' || Array.isArray(photo)) throw new QueryValidationError(`Photo ${index + 1} must be an object`);
  const keys = Object.keys(photo);
  if (keys.length !== PHOTO_FIELDS.length || PHOTO_FIELDS.some((key) => !Object.hasOwn(photo, key))) {
    throw new QueryValidationError(`Photo ${index + 1} must contain exactly the catalog photo fields`);
  }
  assertBoundedString(photo.id, `Photo ${index + 1} id`, 100);
  assertBoundedString(photo.title, `Photo ${index + 1} title`);
  assertBoundedString(photo.filename, `Photo ${index + 1} filename`, MAX_FILENAME_LENGTH);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.svg$/.test(photo.filename) || photo.filename.includes('..')) {
    throw new QueryValidationError(`Photo ${index + 1} filename must be a safe .svg filename`);
  }
  assertBoundedString(photo.url, `Photo ${index + 1} url`, MAX_URL_LENGTH);
  if (photo.url !== `/photos/${photo.filename}` || !/^\/photos\/[A-Za-z0-9][A-Za-z0-9._-]*\.svg$/.test(photo.url)) {
    throw new QueryValidationError(`Photo ${index + 1} url must be a safe local /photos/*.svg URL`);
  }
  assertBoundedString(photo.location, `Photo ${index + 1} location`);
  if (typeof photo.date !== 'string' || !isValidDate(photo.date)) throw new QueryValidationError(`Photo ${index + 1} date must be a valid YYYY-MM-DD date`);
  if (!Array.isArray(photo.tags) || photo.tags.length > MAX_TAGS) throw new QueryValidationError(`Photo ${index + 1} tags must be an array of ${MAX_TAGS} items or fewer`);
  for (const tag of photo.tags) assertBoundedString(tag, `Photo ${index + 1} tag`);
  assertBoundedString(photo.label, `Photo ${index + 1} label`);
  if (typeof photo.favorite !== 'boolean') throw new QueryValidationError(`Photo ${index + 1} favorite must be a boolean`);
  assertBoundedString(photo.color, `Photo ${index + 1} color`, 20);
  for (const field of ['width', 'height']) {
    if (!Number.isSafeInteger(photo[field]) || photo[field] < 1 || photo[field] > 100000) {
      throw new QueryValidationError(`Photo ${index + 1} ${field} must be a positive safe integer`);
    }
  }
  return photo;
}

export function validateCatalogPhotos(photos) {
  if (!Array.isArray(photos) || photos.length > MAX_PHOTOS) throw new QueryValidationError(`Catalog photos must be an array of ${MAX_PHOTOS} records or fewer`);
  const ids = new Set();
  return photos.map((photo, index) => {
    const valid = validatePhoto(photo, index);
    if (ids.has(valid.id)) throw new QueryValidationError(`Catalog photo ids must be unique (duplicate: ${valid.id})`);
    ids.add(valid.id);
    return valid;
  });
}

export function openCatalog(filename) {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  const hadPhotosTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'photos'").get());
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      filename TEXT NOT NULL,
      url TEXT NOT NULL,
      location TEXT NOT NULL,
      date TEXT NOT NULL,
      tags TEXT NOT NULL,
      label TEXT NOT NULL,
      favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
      color TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS saved_searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      query TEXT NOT NULL,
      reference_date TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS search_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      sort TEXT NOT NULL,
      result_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  if (!hadPhotosTable) {
    const insert = db.prepare(`INSERT INTO photos (id,title,filename,url,location,date,tags,label,favorite,color,width,height) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const photo of catalogPhotos) {
      const [id, title, filenameValue, location, date, tags, label, favorite, color, width, height] = photo;
      insert.run(id, title, filenameValue, `/photos/${filenameValue}`, location, date, JSON.stringify(tags), label, favorite ? 1 : 0, color, width, height);
    }
  }
  return db;
}

export function listPhotos(db, where = '1 = 1', params = [], orderBy = 'p.date DESC, p.id ASC') {
  const rows = db.prepare(`SELECT p.id,p.title,p.filename,p.url,p.location,p.date,p.tags,p.label,p.favorite,p.color,p.width,p.height FROM photos p WHERE ${where} ORDER BY ${orderBy}`).all(...params);
  return rows.map((row) => photoFromRow({ ...row, favorite: Boolean(row.favorite) }));
}

export function catalogSummary(db) {
  const photos = listPhotos(db);
  const tags = [...new Set(photos.flatMap((photo) => photo.tags))].sort();
  const labels = [...new Set(photos.map((photo) => photo.label))].sort();
  const locations = [...new Set(photos.map((photo) => photo.location))].sort();
  return { photos, facets: { tags, labels, locations }, stats: { total: photos.length, favorites: photos.filter((photo) => photo.favorite).length, locations: locations.length } };
}

export function listSavedSearches(db) {
  return db.prepare('SELECT id,name,query,reference_date AS referenceDate,created_at AS createdAt FROM saved_searches ORDER BY id DESC').all()
    .map((row) => ({ ...row, query: JSON.parse(row.query) }));
}

export function createSavedSearch(db, { name, query, referenceDate, createdAt = new Date().toISOString() }) {
  const result = db.prepare('INSERT INTO saved_searches (name,query,reference_date,created_at) VALUES (?,?,?,?)')
    .run(name, JSON.stringify(query), referenceDate, createdAt);
  const row = db.prepare('SELECT id,name,query,reference_date AS referenceDate,created_at AS createdAt FROM saved_searches WHERE id = ?').get(result.lastInsertRowid);
  return { ...row, query: JSON.parse(row.query) };
}

export function deleteSavedSearch(db, id) {
  return db.prepare('DELETE FROM saved_searches WHERE id = ?').run(id).changes === 1;
}

export function exportCatalog(db) {
  return { version: CATALOG_EXPORT_VERSION, exportedAt: new Date().toISOString(), photos: listPhotos(db) };
}

export function replaceCatalog(db, photos) {
  const validPhotos = validateCatalogPhotos(photos);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM photos');
    const insert = db.prepare(`INSERT INTO photos (id,title,filename,url,location,date,tags,label,favorite,color,width,height) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const photo of validPhotos) {
      insert.run(photo.id, photo.title, photo.filename, photo.url, photo.location, photo.date, JSON.stringify(photo.tags), photo.label, photo.favorite ? 1 : 0, photo.color, photo.width, photo.height);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return validPhotos.length;
}

export function listSearchHistory(db) {
  return db.prepare('SELECT id,query,sort,result_count AS resultCount,created_at AS createdAt FROM search_history ORDER BY id DESC').all()
    .map((row) => {
      const query = JSON.parse(row.query);
      compileQuery(query, row.sort);
      return { ...row, query };
    });
}

export function createSearchHistory(db, { query, sort, resultCount, createdAt = new Date().toISOString() }) {
  compileQuery(query, sort);
  const result = db.prepare('INSERT INTO search_history (query,sort,result_count,created_at) VALUES (?,?,?,?)')
    .run(JSON.stringify(query), sort, resultCount, createdAt);
  const row = db.prepare('SELECT id,query,sort,result_count AS resultCount,created_at AS createdAt FROM search_history WHERE id = ?').get(result.lastInsertRowid);
  return { ...row, query: JSON.parse(row.query) };
}

export function deleteSearchHistory(db) {
  return db.prepare('DELETE FROM search_history').run().changes;
}
