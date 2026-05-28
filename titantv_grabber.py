
import sqlite3
import requests
import datetime
import json
import os
import sys
import argparse
from uuid import UUID

# Config
DB_FILE = 'titantv.db'
BASE_URL = 'https://titantv.com/api'

# Schema creation
def init_db():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.executescript('''
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
    ''')
    
    # Channels migration: add channel_index
    try:
        c.execute("SELECT channel_index FROM channels LIMIT 1")
    except sqlite3.OperationalError:
        print("Migrating schema: Adding channel_index column to channels table")
        c.execute("ALTER TABLE channels ADD COLUMN channel_index INTEGER")

    # Simple migration: check if new_repeat column exists
    try:
        c.execute("SELECT new_repeat FROM programs LIMIT 1")
    except sqlite3.OperationalError:
        print("Migrating schema: Adding new_repeat column to programs table")
        c.execute("ALTER TABLE programs ADD COLUMN new_repeat TEXT")
    conn.commit()
    conn.close()

def save_channel(conn, ch):
    # Map API ch object to DB
    # ch: { channelId, majorChannel, minorChannel, callSign, description, logo, channelIndex }
    c = conn.cursor()
    
    minor = f".{ch.get('minorChannel')}" if ch.get('minorChannel') else ""
    channel_num = f"{ch.get('majorChannel')}{minor}"

    try:
        c.execute('''
            INSERT INTO channels (external_id, channel_number, callsign, name, logo_url, channel_index)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(external_id) DO UPDATE SET
                channel_number=excluded.channel_number,
                callsign=excluded.callsign,
                name=excluded.name,
                logo_url=excluded.logo_url,
                channel_index=excluded.channel_index
            RETURNING id
        ''', (
            str(ch.get('channelId')),
            channel_num,
            ch.get('callSign'),
            ch.get('description'),
            ch.get('logo'),
            ch.get('channelIndex')
        ))
        row = c.fetchone()
        return row[0]
    except Exception as e:
        print(f"Error saving channel {channel_num}: {e}")
        return None

def save_program(conn, db_ch_id, evt):
    c = conn.cursor()
    
    # Parse Dates
    # evt.startTime / endTime are ISO strings: 2026-01-29T10:00:00
    try:
        start_dt = datetime.datetime.fromisoformat(evt.get('startTime'))
        end_dt = datetime.datetime.fromisoformat(evt.get('endTime'))
        start_ts = int(start_dt.timestamp())
        end_ts = int(end_dt.timestamp())
        
        # Genres
        genres = []
        if evt.get('displayGenre'): genres.append(evt.get('displayGenre'))
        if evt.get('programType'): genres.append(evt.get('programType'))
        
        c.execute('''
            INSERT INTO programs (
                channel_id, title, sub_title, description, image_url, start_time, end_time,
                season_num, episode_num, year, original_air_date, rating, star_rating, genres, program_type, is_new, new_repeat
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
        ''', (
            db_ch_id,
            evt.get('title'),
            evt.get('episodeTitle') or evt.get('subTitle') or '',
            evt.get('description'),
            evt.get('showCard'),
            start_ts,
            end_ts,
            evt.get('seasonNumber'),
            evt.get('seasonEpisodeNumber'),
            evt.get('year'),
            evt.get('originalAirDate'),
            evt.get('tvRating') or evt.get('mpaaRating'),
            evt.get('starRating'),
            json.dumps(genres),
            evt.get('programType'),
            1 if evt.get('newRepeat') in ('New', 'N') else 0,
            evt.get('newRepeat')
        ))
    except Exception as e:
        print(f"Error saving program: {e}")

def fetch_schedule(user_id, lineup_id, start_dt, duration_mins=360):
    url_date = start_dt.strftime('%Y%m%d%H%M')
    url = f"{BASE_URL}/schedule/{user_id}/{lineup_id}/{url_date}/{duration_mins}"
    print(f"Fetching: {url}")
    
    try:
        r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'})
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"Error fetching schedule: {e}")
        return None

def fetch_user_lineups(user_id):
    url = f"{BASE_URL}/lineup/{user_id}"
    print(f"Fetching Lineups: {url}")
    try:
        r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'})
        r.raise_for_status()
        data = r.json()
        return data.get('lineups', [])
    except Exception as e:
        print(f"Error fetching lineups: {e}")
        return []

def fetch_and_save_block(conn, user_id, lineup_id, start_dt, channel_map):
    data = fetch_schedule(user_id, lineup_id, start_dt)
    if not data or 'channels' not in data:
        return 0
        
    count = 0
    
    for ch_entry in data['channels']:
        # We need to map ch_entry['channelIndex'] to our DB ID.
        if 'channelIndex' in ch_entry and ch_entry['channelIndex'] in channel_map:
            db_id = channel_map[ch_entry['channelIndex']]
            if 'days' in ch_entry:
                for day in ch_entry['days']:
                    if 'events' in day:
                        for evt in day['events']:
                            save_program(conn, db_id, evt)
                            count += 1
    return count

# XML generation
def generate_xml(conn, output_file='xmltv.xml'):
    import xml.etree.ElementTree as ET
    from xml.dom import minidom
    
    root = ET.Element('tv')
    
    c = conn.cursor()
    
    # Channels
    c.execute("SELECT id, channel_number, callsign, logo_url FROM channels ORDER BY channel_number")
    channels = c.fetchall()
    
    for ch_id, num, call, logo in channels:
        ch_elm = ET.SubElement(root, 'channel', id=str(num))
        dn = ET.SubElement(ch_elm, 'display-name')
        dn.text = f"{num} {call}"
        if logo:
            ET.SubElement(ch_elm, 'icon', src=logo)
            
    # Programs
    # Fetch for next 7 days
    now_ts = int(datetime.datetime.now().timestamp())
    
    c.execute("""
        SELECT p.title, p.sub_title, p.description, p.image_url, p.start_time, p.end_time,
               p.year, p.genres, p.program_type, p.season_num, p.episode_num, 
               p.rating, p.star_rating, p.is_new, p.original_air_date, p.new_repeat,
               c.channel_number
        FROM programs p
        JOIN channels c ON p.channel_id = c.id
        WHERE p.start_time >= ?
        ORDER BY p.start_time
    """, (now_ts - 7200,)) # -2 hours buffer
    
    programs = c.fetchall()
    
    for prog in programs:
        (title, subtitle, desc, img, start, end, year, genres_json, ptype, 
         s_num, e_num, rating, stars, is_new, air_date, new_repeat, ch_num) = prog
         
        start_dt = datetime.datetime.fromtimestamp(start)
        end_dt = datetime.datetime.fromtimestamp(end)
        
        start_str = start_dt.strftime('%Y%m%d%H%M%S -0500') # Hardcoded EST for now matching old scraper buffer
        end_str = end_dt.strftime('%Y%m%d%H%M%S -0500')
        
        p_elm = ET.SubElement(root, 'programme', start=start_str, stop=end_str, channel=str(ch_num))
        
        ET.SubElement(p_elm, 'title').text = title
        if subtitle: ET.SubElement(p_elm, 'sub-title').text = subtitle
        if desc: ET.SubElement(p_elm, 'desc').text = desc
        if img: ET.SubElement(p_elm, 'icon', src=img)
        if year: ET.SubElement(p_elm, 'date').text = str(year)
        
        # Categories
        cats = set()
        if genres_json:
            try:
                g_list = json.loads(genres_json)
                for g in g_list: cats.add(g)
            except: pass
            
        if ptype != 'Movie':
            cats.add('Series')
            
        for cat in cats:
            ET.SubElement(p_elm, 'category').text = cat
            
        # Episode
        if s_num or e_num:
            s = (s_num - 1) if s_num else 0
            e = (e_num - 1) if e_num else 0
            ep = ET.SubElement(p_elm, 'episode-num', system='xmltv_ns')
            ep.text = f"{s}.{e}."
        elif ptype != 'Movie':
            # Spoof
            # Season = YY, Episode = MMDD
            yy = int(start_dt.strftime('%y')) - 1
            mmdd = int(start_dt.strftime('%m%d')) - 1
            ep = ET.SubElement(p_elm, 'episode-num', system='xmltv_ns')
            ep.text = f"{yy}.{mmdd}."
            
        is_news = any(c.lower() == 'news' for c in cats)
        if new_repeat in ('New', 'N') or is_new or is_news:
            ET.SubElement(p_elm, 'new')
        elif new_repeat in ('R', 'Repeat'):
             ET.SubElement(p_elm, 'previously-shown')
        elif air_date:
            ET.SubElement(p_elm, 'previously-shown')
            
        if rating:
            r_elm = ET.SubElement(p_elm, 'rating', system='VCHIP')
            ET.SubElement(r_elm, 'value').text = rating
            
    # Write
    tree = ET.ElementTree(root)
    xmlstr = minidom.parseString(ET.tostring(root)).toprettyxml(indent="  ")
    with open(output_file, "w") as f:
        f.write(xmlstr)


def main():
    parser = argparse.ArgumentParser(description='TitanTV Native Scraper')
    parser.add_argument('--user', required=True, help='TitanTV User ID (UUID)')
    parser.add_argument('--lineup', help='Lineup ID (UUID). If not provided, will try to fetch.')
    
    args = parser.parse_args()
    
    init_db()
    conn = sqlite3.connect(DB_FILE)
    
    # We need a lineup ID.
    lineup_id = args.lineup
    
    if not lineup_id:
        print(f"No lineup specified. Fetching lineups for user {args.user}...")
        lineups = fetch_user_lineups(args.user)
        if not lineups:
             print("Error: No lineups found for this user.")
             sys.exit(1)
             
        if len(lineups) == 1:
            l = lineups[0]
            print(f"Found exactly one lineup: {l['lineupName']} ({l['lineupId']})")
            print("Using this lineup automatically.")
            lineup_id = l['lineupId']
        else:
            print(f"Found {len(lineups)} lineups:")
            for l in lineups:
                print(f"  - {l['lineupName']}: {l['lineupId']}")
            print("\nPlease specify one using --lineup <ID>")
            sys.exit(1)
        
    channel_map = {} # Map channelIndex -> db_id
    
    # 1. Load from JSON Dump (The Bridge from Node)
    dump_file = 'channel_dump.json'
    if not os.path.exists(dump_file):
        dump_file = '../titantv-scraper/data/channel_dump.json'
    
    if os.path.exists(dump_file):
        print(f"Loading channel map from {dump_file}...")
        try:
            with open(dump_file, 'r') as f:
                channels_data = json.load(f)
                print(f"Loaded {len(channels_data)} channels from dump.")
                for ch in channels_data:
                    db_id = save_channel(conn, ch)
                    if db_id:
                        if 'channelIndex' in ch:
                            channel_map[ch['channelIndex']] = db_id
                        elif 'channelId' in ch:
                            channel_map[ch['channelId']] = db_id
        except Exception as e:
            print(f"Error reading dump file: {e}")
            
    # 2. Fetch from API
    print("Fetching channels from API...")
    try:
        # Correct endpoint discovered: /api/channel/{userId}/{lineupId}
        url = f"{BASE_URL}/channel/{args.user}/{lineup_id}"
        r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'})
        if r.status_code == 200:
            data = r.json()
            if 'channels' in data:
                print(f"Found {len(data['channels'])} channels from API.")
                for ch in data['channels']:
                    db_id = save_channel(conn, ch)
                    if db_id:
                        if 'channelIndex' in ch:
                            channel_map[ch['channelIndex']] = db_id
                        elif 'channelId' in ch:
                            channel_map[ch['channelId']] = db_id
            else:
                print("No 'channels' in API response.")
        else:
             print(f"Failed to fetch channels from API: {r.status_code}")
    except Exception as e:
        print(f"Channel fetch error: {e}")
        
    if not channel_map:
        # Fallback 3: Load from DB (now including channel_index)
        c = conn.cursor()
        c.execute("SELECT id, channel_index, external_id FROM channels WHERE channel_index IS NOT NULL")
        rows = c.fetchall()
        if rows:
            print(f"Loaded {len(rows)} channels from database mapping (Fallback).")
            for db_id, ch_idx, ext_id in rows:
                channel_map[ch_idx] = db_id

    if not channel_map:
        print("Warning: No channels mapped. Schedule ingest will fail.")
        
    # FETCH SCHEDULE
    # 28 blocks (7 days) of 6 hours
    start_time = datetime.datetime.now().replace(minute=0, second=0, microsecond=0)
    for i in range(28):
        fetch_and_save_block(conn, args.user, lineup_id, start_time, channel_map)
        start_time += datetime.timedelta(hours=6)
        
    conn.commit()
    
    # GENERATE XML
    print("Generating XMLTV...")
    generate_xml(conn)
    print("Done.")

if __name__ == "__main__":
    main()
