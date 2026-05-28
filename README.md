# titantv-grabber

`titantv-grabber` fetches TitanTV guide data, stores it in a local SQLite database, and writes an XMLTV file for DVR/media-server consumers such as Jellyfin.

The grabber is intended to run on a timer. Each run refreshes channel/program data from TitanTV, keeps the local `titantv.db` cache updated, and regenerates `xmltv.xml` in the application directory.

## Files

- `titantv_grabber.py` - TitanTV API fetcher, SQLite cache updater, and XMLTV generator.
- `titantv-grabber.service` - systemd oneshot service for running the grabber as the `jellyfin` user.
- `titantv-grabber.timer` - systemd timer that runs the service every 12 hours.
- `titantv-grabber.env.example` - example environment file for the TitanTV user and lineup IDs.
- `requirements.txt` - Python runtime dependency list.

Generated files such as `titantv.db`, `xmltv.xml`, logs, channel dumps, debug scripts, and Python cache files are intentionally ignored by Git.

## Requirements

- Python 3.10 or newer
- `requests`
- A TitanTV user ID and lineup ID
- systemd, for timer-based operation

On Arch Linux:

```bash
sudo pacman -S python python-pip
python -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
```

For a system installation that runs as `jellyfin`, install the dependency for the system Python or adjust the service `ExecStart` to point at a virtualenv Python.

## Configuration

Create the environment file used by the systemd service:

```bash
sudo install -d -m 0755 /etc/titantv-grabber
sudo install -m 0640 -o root -g jellyfin titantv-grabber.env.example /etc/titantv-grabber/titantv-grabber.env
sudoedit /etc/titantv-grabber/titantv-grabber.env
```

Set both values:

```bash
TITANTV_USER_ID=your-titantv-user-uuid
TITANTV_LINEUP_ID=your-titantv-lineup-uuid
```

### Finding TitanTV IDs

The grabber needs the TitanTV user UUID and lineup UUID that TitanTV uses in its internal API requests. These values are account/location specific, so keep them in `/etc/titantv-grabber/titantv-grabber.env` and do not commit them.

To find the user ID and current lineup ID:

1. Sign in to TitanTV and open the listings page for the lineup you want to export.
2. Open your browser developer tools and select the Network tab.
3. Refresh the listings page, change the date, or move through the guide so TitanTV reloads schedule data.
4. Filter network requests for `api/schedule` or `api/channel`.
5. Look for a URL shaped like one of these:

   ```text
   https://titantv.com/api/schedule/<user-id>/<lineup-id>/<yyyymmddhhmm>/<duration>
   https://titantv.com/api/channel/<user-id>/<lineup-id>
   ```

6. Copy the first UUID into `TITANTV_USER_ID` and the second UUID into `TITANTV_LINEUP_ID`.

If you know the user ID but are not sure which lineup ID to use, run the grabber without `--lineup`:

```bash
python titantv_grabber.py --user "$TITANTV_USER_ID"
```

When TitanTV returns multiple lineups, the command prints each lineup name and ID so you can choose the one to put in `TITANTV_LINEUP_ID`.

## Manual Run

From the application directory:

```bash
python titantv_grabber.py --user "$TITANTV_USER_ID" --lineup "$TITANTV_LINEUP_ID"
```

The command writes `titantv.db` and `xmltv.xml` in the current working directory.

## Jellyfin News Recordings

Jellyfin can be reluctant to create series recordings for guide entries that are only categorized as news. The generated XMLTV output keeps the `News` category, but also emits non-movie programs with a `Series` category and a synthetic `episode-num` when TitanTV does not provide season/episode data. News programs are also marked with XMLTV `<new>` metadata.

This rewrite is intentional: it makes recurring news programs look like recordable series episodes to Jellyfin while preserving the original news categorization for guide browsing.

## Install Under `/opt`

The provided systemd units assume the application is installed at `/opt/titantv-grabber` and runs as `jellyfin`:

```bash
sudo install -d -o jellyfin -g jellyfin -m 0755 /opt/titantv-grabber
sudo rsync -a --exclude .git --exclude .venv --exclude titantv.db --exclude xmltv.xml --exclude "*.log" ./ /opt/titantv-grabber/
sudo chown -R jellyfin:jellyfin /opt/titantv-grabber
```

Add the systemd units with `systemctl link`, then enable the timer:

```bash
sudo systemctl link /opt/titantv-grabber/titantv-grabber.service /opt/titantv-grabber/titantv-grabber.timer
sudo systemctl daemon-reload
sudo systemctl enable --now titantv-grabber.timer
```

Check status and logs:

```bash
systemctl status titantv-grabber.timer
journalctl -u titantv-grabber.service -n 100 --no-pager
```

Run a refresh immediately:

```bash
sudo systemctl start titantv-grabber.service
```

## Jellyfin XMLTV

Point Jellyfin's XMLTV guide source at:

```text
/opt/titantv-grabber/xmltv.xml
```

Ensure the `jellyfin` user can read the file and write to `/opt/titantv-grabber` when the service runs.
