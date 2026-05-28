#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const Database = require('better-sqlite3');

const DB_FILE = process.env.TITANTV_DB_FILE || 'titantv.db';
const BASE_URL = 'https://titantv.com/api';

function usage() {
  console.error('Usage: node titantv_grabber.js --user <uuid> [--lineup <uuid>]');
}

function parseArgs(argv) {
  const args = { user: null, lineup: null };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--user') {
      args.user = argv[++i];
    } else if (arg === '--lineup') {
      args.lineup = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.user) {
    throw new Error('Missing required --user value');
  }

  return args;
}

function initDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT UNIQUE,
      channel_number TEXT,
      callsign TEXT,
      name TEXT,
      logo_url TEXT,
      channel_index INTEGER
    );

    CREATE TABLE IF NOT EXISTS programs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER,
      title TEXT,
      sub_title TEXT,
      description TEXT,
      image_url TEXT,
      start_time INTEGER,
      end_time INTEGER,
      season_num INTEGER,
      episode_num INTEGER,
      year INTEGER,
      original_air_date TEXT,
      rating TEXT,
      star_rating REAL,
      genres TEXT,
      program_type TEXT,
      is_new INTEGER,
      new_repeat TEXT,
      FOREIGN KEY(channel_id) REFERENCES channels(id),
      UNIQUE(channel_id, start_time)
    );
  `);

  try {
    db.prepare('SELECT channel_index FROM channels LIMIT 1').get();
  } catch (_err) {
    console.log('Migrating schema: Adding channel_index column to channels table');
    db.exec('ALTER TABLE channels ADD COLUMN channel_index INTEGER');
  }

  try {
    db.prepare('SELECT new_repeat FROM programs LIMIT 1').get();
  } catch (_err) {
    console.log('Migrating schema: Adding new_repeat column to programs table');
    db.exec('ALTER TABLE programs ADD COLUMN new_repeat TEXT');
  }
}

function saveChannel(db, ch) {
  const minor = ch.minorChannel ? `.${ch.minorChannel}` : '';
  const channelNumber = `${ch.majorChannel}${minor}`;

  try {
    const row = db.prepare(`
      INSERT INTO channels (external_id, channel_number, callsign, name, logo_url, channel_index)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_id) DO UPDATE SET
        channel_number=excluded.channel_number,
        callsign=excluded.callsign,
        name=excluded.name,
        logo_url=excluded.logo_url,
        channel_index=excluded.channel_index
      RETURNING id
    `).get(
      String(ch.channelId),
      channelNumber,
      ch.callSign ?? null,
      ch.description ?? null,
      ch.logo ?? null,
      ch.channelIndex ?? null,
    );
    return row.id;
  } catch (err) {
    console.log(`Error saving channel ${channelNumber}: ${err.message}`);
    return null;
  }
}

function parseTitanTime(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  return Math.floor(time / 1000);
}

function saveProgram(db, dbChannelId, evt) {
  const startTs = parseTitanTime(evt.startTime);
  const endTs = parseTitanTime(evt.endTime);
  if (!startTs || !endTs) {
    console.log('Error saving program: invalid start or end time');
    return;
  }

  const genres = [];
  if (evt.displayGenre) genres.push(evt.displayGenre);
  if (evt.programType) genres.push(evt.programType);

  try {
    db.prepare(`
      INSERT INTO programs (
        channel_id, title, sub_title, description, image_url, start_time, end_time,
        season_num, episode_num, year, original_air_date, rating, star_rating, genres,
        program_type, is_new, new_repeat
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_id, start_time) DO UPDATE SET
        title=excluded.title,
        sub_title=excluded.sub_title,
        description=excluded.description,
        image_url=excluded.image_url,
        end_time=excluded.end_time,
        season_num=excluded.season_num,
        episode_num=excluded.episode_num,
        year=excluded.year,
        original_air_date=excluded.original_air_date,
        rating=excluded.rating,
        star_rating=excluded.star_rating,
        genres=excluded.genres,
        program_type=excluded.program_type,
        is_new=excluded.is_new,
        new_repeat=excluded.new_repeat
    `).run(
      dbChannelId,
      evt.title ?? null,
      evt.episodeTitle || evt.subTitle || '',
      evt.description ?? null,
      evt.showCard ?? null,
      startTs,
      endTs,
      evt.seasonNumber ?? null,
      evt.seasonEpisodeNumber ?? null,
      evt.year ?? null,
      evt.originalAirDate ?? null,
      evt.tvRating || evt.mpaaRating || null,
      evt.starRating ?? null,
      JSON.stringify(genres),
      evt.programType ?? null,
      evt.newRepeat === 'New' || evt.newRepeat === 'N' ? 1 : 0,
      evt.newRepeat ?? null,
    );
  } catch (err) {
    console.log(`Error saving program: ${err.message}`);
  }
}

function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}

function formatTitanDate(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
}

async function fetchJson(url, label) {
  console.log(`${label}: ${url}`);
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchSchedule(userId, lineupId, startDate, durationMins = 360) {
  const urlDate = formatTitanDate(startDate);
  const url = `${BASE_URL}/schedule/${userId}/${lineupId}/${urlDate}/${durationMins}`;
  try {
    return await fetchJson(url, 'Fetching');
  } catch (err) {
    console.log(`Error fetching schedule: ${err.message}`);
    return null;
  }
}

async function fetchUserLineups(userId) {
  const url = `${BASE_URL}/lineup/${userId}`;
  try {
    const data = await fetchJson(url, 'Fetching Lineups');
    return data.lineups || [];
  } catch (err) {
    console.log(`Error fetching lineups: ${err.message}`);
    return [];
  }
}

async function fetchAndSaveBlock(db, userId, lineupId, startDate, channelMap) {
  const data = await fetchSchedule(userId, lineupId, startDate);
  if (!data || !Array.isArray(data.channels)) {
    return 0;
  }

  let count = 0;
  for (const channelEntry of data.channels) {
    if (!Object.hasOwn(channelEntry, 'channelIndex') || !channelMap.has(channelEntry.channelIndex)) {
      continue;
    }

    const dbId = channelMap.get(channelEntry.channelIndex);
    for (const day of channelEntry.days || []) {
      for (const evt of day.events || []) {
        saveProgram(db, dbId, evt);
        count += 1;
      }
    }
  }
  return count;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function element(name, text, attrs = {}, indent = '  ') {
  const attrText = Object.entries(attrs)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join('');

  if (text === null || text === undefined) {
    return `${indent}<${name}${attrText}/>`;
  }
  return `${indent}<${name}${attrText}>${escapeXml(text)}</${name}>`;
}

function formatXmltvDate(timestamp) {
  const date = new Date(timestamp * 1000);
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())} -0500`;
}

function generateXml(db, outputFile = 'xmltv.xml') {
  const lines = ['<?xml version="1.0" ?>', '<tv>'];

  const channels = db.prepare(`
    SELECT id, channel_number, callsign, logo_url
    FROM channels
    ORDER BY channel_number
  `).all();

  for (const ch of channels) {
    lines.push(`  <channel id="${escapeXml(ch.channel_number)}">`);
    lines.push(element('display-name', `${ch.channel_number} ${ch.callsign ?? ''}`.trim(), {}, '    '));
    if (ch.logo_url) lines.push(element('icon', null, { src: ch.logo_url }, '    '));
    lines.push('  </channel>');
  }

  const nowTs = Math.floor(Date.now() / 1000);
  const programs = db.prepare(`
    SELECT p.title, p.sub_title, p.description, p.image_url, p.start_time, p.end_time,
           p.year, p.genres, p.program_type, p.season_num, p.episode_num,
           p.rating, p.star_rating, p.is_new, p.original_air_date, p.new_repeat,
           c.channel_number
    FROM programs p
    JOIN channels c ON p.channel_id = c.id
    WHERE p.start_time >= ?
    ORDER BY p.start_time
  `).all(nowTs - 7200);

  for (const prog of programs) {
    const attrs = {
      start: formatXmltvDate(prog.start_time),
      stop: formatXmltvDate(prog.end_time),
      channel: prog.channel_number,
    };
    lines.push(`  <programme start="${escapeXml(attrs.start)}" stop="${escapeXml(attrs.stop)}" channel="${escapeXml(attrs.channel)}">`);

    lines.push(element('title', prog.title ?? '', {}, '    '));
    if (prog.sub_title) lines.push(element('sub-title', prog.sub_title, {}, '    '));
    if (prog.description) lines.push(element('desc', prog.description, {}, '    '));
    if (prog.image_url) lines.push(element('icon', null, { src: prog.image_url }, '    '));
    if (prog.year) lines.push(element('date', prog.year, {}, '    '));

    const categories = new Set();
    if (prog.genres) {
      try {
        for (const genre of JSON.parse(prog.genres)) {
          categories.add(genre);
        }
      } catch (_err) {
        // Ignore malformed cached genre JSON and keep rendering the rest of the guide.
      }
    }

    if (prog.program_type !== 'Movie') {
      categories.add('Series');
    }

    for (const category of categories) {
      lines.push(element('category', category, {}, '    '));
    }

    if (prog.season_num || prog.episode_num) {
      const season = prog.season_num ? prog.season_num - 1 : 0;
      const episode = prog.episode_num ? prog.episode_num - 1 : 0;
      lines.push(element('episode-num', `${season}.${episode}.`, { system: 'xmltv_ns' }, '    '));
    } else if (prog.program_type !== 'Movie') {
      const startDate = new Date(prog.start_time * 1000);
      const season = Number(pad(startDate.getFullYear() % 100)) - 1;
      const episode = Number(`${pad(startDate.getMonth() + 1)}${pad(startDate.getDate())}`) - 1;
      lines.push(element('episode-num', `${season}.${episode}.`, { system: 'xmltv_ns' }, '    '));
    }

    const isNews = Array.from(categories).some((category) => category.toLowerCase() === 'news');
    if (prog.new_repeat === 'New' || prog.new_repeat === 'N' || prog.is_new || isNews) {
      lines.push('    <new/>');
    } else if (prog.new_repeat === 'R' || prog.new_repeat === 'Repeat' || prog.original_air_date) {
      lines.push('    <previously-shown/>');
    }

    if (prog.rating) {
      lines.push('    <rating system="VCHIP">');
      lines.push(element('value', prog.rating, {}, '      '));
      lines.push('    </rating>');
    }

    lines.push('  </programme>');
  }

  lines.push('</tv>', '');
  fs.writeFileSync(outputFile, lines.join('\n'));
}

function loadChannelDump(db, channelMap) {
  let dumpFile = 'channel_dump.json';
  if (!fs.existsSync(dumpFile)) {
    dumpFile = '../titantv-scraper/data/channel_dump.json';
  }

  if (!fs.existsSync(dumpFile)) {
    return;
  }

  console.log(`Loading channel map from ${dumpFile}...`);
  try {
    const channels = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));
    console.log(`Loaded ${channels.length} channels from dump.`);
    for (const ch of channels) {
      const dbId = saveChannel(db, ch);
      if (dbId) {
        if (Object.hasOwn(ch, 'channelIndex')) {
          channelMap.set(ch.channelIndex, dbId);
        } else if (Object.hasOwn(ch, 'channelId')) {
          channelMap.set(ch.channelId, dbId);
        }
      }
    }
  } catch (err) {
    console.log(`Error reading dump file: ${err.message}`);
  }
}

async function fetchChannels(db, userId, lineupId, channelMap) {
  console.log('Fetching channels from API...');
  try {
    const url = `${BASE_URL}/channel/${userId}/${lineupId}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (response.status !== 200) {
      console.log(`Failed to fetch channels from API: ${response.status}`);
      return;
    }

    const data = await response.json();
    if (!Array.isArray(data.channels)) {
      console.log("No 'channels' in API response.");
      return;
    }

    console.log(`Found ${data.channels.length} channels from API.`);
    for (const ch of data.channels) {
      const dbId = saveChannel(db, ch);
      if (dbId) {
        if (Object.hasOwn(ch, 'channelIndex')) {
          channelMap.set(ch.channelIndex, dbId);
        } else if (Object.hasOwn(ch, 'channelId')) {
          channelMap.set(ch.channelId, dbId);
        }
      }
    }
  } catch (err) {
    console.log(`Channel fetch error: ${err.message}`);
  }
}

function loadChannelMapFromDb(db, channelMap) {
  const rows = db.prepare(`
    SELECT id, channel_index, external_id
    FROM channels
    WHERE channel_index IS NOT NULL
  `).all();

  if (rows.length) {
    console.log(`Loaded ${rows.length} channels from database mapping (Fallback).`);
    for (const row of rows) {
      channelMap.set(row.channel_index, row.id);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = new Database(DB_FILE);
  initDb(db);

  let lineupId = args.lineup;
  if (!lineupId) {
    console.log(`No lineup specified. Fetching lineups for user ${args.user}...`);
    const lineups = await fetchUserLineups(args.user);
    if (!lineups.length) {
      console.log('Error: No lineups found for this user.');
      process.exitCode = 1;
      return;
    }

    if (lineups.length === 1) {
      const lineup = lineups[0];
      console.log(`Found exactly one lineup: ${lineup.lineupName} (${lineup.lineupId})`);
      console.log('Using this lineup automatically.');
      lineupId = lineup.lineupId;
    } else {
      console.log(`Found ${lineups.length} lineups:`);
      for (const lineup of lineups) {
        console.log(`  - ${lineup.lineupName}: ${lineup.lineupId}`);
      }
      console.log('\nPlease specify one using --lineup <ID>');
      process.exitCode = 1;
      return;
    }
  }

  const channelMap = new Map();
  loadChannelDump(db, channelMap);
  await fetchChannels(db, args.user, lineupId, channelMap);

  if (!channelMap.size) {
    loadChannelMapFromDb(db, channelMap);
  }

  if (!channelMap.size) {
    console.log('Warning: No channels mapped. Schedule ingest will fail.');
  }

  let startTime = new Date();
  startTime.setMinutes(0, 0, 0);
  for (let i = 0; i < 28; i += 1) {
    await fetchAndSaveBlock(db, args.user, lineupId, startTime, channelMap);
    startTime = new Date(startTime.getTime() + 6 * 60 * 60 * 1000);
  }

  console.log('Generating XMLTV...');
  generateXml(db);
  db.close();
  console.log('Done.');
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
