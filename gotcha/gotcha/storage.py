"""SQLite persistence. The only module in the project that contains SQL.

Design notes for the non-coder reading this:

* Everything lives in ONE file on disk (default `gotcha.db`). No database
  server to install, no configuration. 16 players is nothing for SQLite.
* Both interfaces (Telegram bot and web app) can point at the same file and
  will see the same game. Writes use `BEGIN IMMEDIATE`, so if the bot and the
  website try to change the game at the same instant, one waits for the other
  instead of corrupting anything.
* Secrets (submitted words, current targets) live in the `players` table. They
  are never written to the log and never rendered on an admin page. See the
  README section "Secrecy: what this does and does not protect against".
"""

from __future__ import annotations

import secrets
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional

from .models import (
    ACTIVE,
    CANCELLED,
    CONFIRMED,
    FINISHED,
    LOBBY,
    PENDING,
    FeedItem,
    Game,
    Player,
    Report,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS games (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL,
    state       TEXT    NOT NULL,          -- lobby | active | finished
    winner_id   INTEGER,
    created_at  TEXT    NOT NULL,
    started_at  TEXT,
    finished_at TEXT
);

CREATE TABLE IF NOT EXISTS players (
    id            INTEGER PRIMARY KEY,
    game_id       INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    name          TEXT,                    -- NULL until a web invitee names themself
    token         TEXT    NOT NULL UNIQUE, -- secret, used for the web magic link
    telegram_id   INTEGER,                 -- set when the player joined via Telegram
    word          TEXT,                    -- SECRET: the word this player submitted
    alive         INTEGER NOT NULL DEFAULT 1,
    target_id     INTEGER REFERENCES players(id),  -- SECRET: current mission target
    mission_word  TEXT,                    -- SECRET: current mission word
    joined_at     TEXT    NOT NULL,
    eliminated_at TEXT
);

CREATE TABLE IF NOT EXISTS reports (
    id           INTEGER PRIMARY KEY,
    game_id      INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    reporter_id  INTEGER NOT NULL REFERENCES players(id),
    target_id    INTEGER NOT NULL REFERENCES players(id),
    word         TEXT    NOT NULL,
    state        TEXT    NOT NULL,         -- pending | confirmed | cancelled
    created_at   TEXT    NOT NULL,
    confirmed_by INTEGER REFERENCES players(id),
    confirmed_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY,
    game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    kind       TEXT    NOT NULL,           -- joined | started | elimination | winner | note
    message    TEXT    NOT NULL,
    created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    key     TEXT    NOT NULL,
    value   TEXT,
    PRIMARY KEY (game_id, key)
);

CREATE INDEX IF NOT EXISTS idx_players_game ON players(game_id);
CREATE INDEX IF NOT EXISTS idx_reports_game ON reports(game_id, state);
CREATE INDEX IF NOT EXISTS idx_events_game  ON events(game_id, id);
"""


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_token() -> str:
    """Unguessable id used in web magic links (`/p/<token>`)."""
    return secrets.token_urlsafe(24)


class Storage:
    def __init__(self, path: str = "gotcha.db") -> None:
        self.path = path
        # check_same_thread=False + a lock: the web app serves requests on a
        # thread pool, and we want one connection shared safely.
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._lock:
            self._conn.execute("PRAGMA foreign_keys = ON")
            self._conn.execute("PRAGMA journal_mode = WAL" if path != ":memory:" else "PRAGMA journal_mode = MEMORY")
            self._conn.executescript(SCHEMA)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # -- transactions -------------------------------------------------------

    @contextmanager
    def write(self):
        """Exclusive write transaction: `with storage.write() as cur: ...`"""
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("BEGIN IMMEDIATE")
            try:
                yield cur
            except Exception:
                cur.execute("ROLLBACK")
                raise
            else:
                cur.execute("COMMIT")

    def _query(self, sql: str, args: Iterable = ()) -> List[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, tuple(args)).fetchall()

    def _query_one(self, sql: str, args: Iterable = ()) -> Optional[sqlite3.Row]:
        rows = self._query(sql, args)
        return rows[0] if rows else None

    # -- games --------------------------------------------------------------

    def create_game(self, name: str) -> Game:
        with self.write() as cur:
            cur.execute(
                "INSERT INTO games (name, state, created_at) VALUES (?,?,?)",
                (name, LOBBY, utcnow()),
            )
            game_id = cur.lastrowid
        return self.get_game(game_id)  # type: ignore[return-value]

    def get_game(self, game_id: int) -> Optional[Game]:
        row = self._query_one("SELECT * FROM games WHERE id=?", (game_id,))
        return _game(row) if row else None

    def latest_game(self) -> Optional[Game]:
        row = self._query_one("SELECT * FROM games ORDER BY id DESC LIMIT 1")
        return _game(row) if row else None

    def set_game_state(self, game_id: int, state: str) -> None:
        stamp_col = {ACTIVE: "started_at", FINISHED: "finished_at"}.get(state)
        with self.write() as cur:
            if stamp_col:
                cur.execute(
                    f"UPDATE games SET state=?, {stamp_col}=? WHERE id=?",
                    (state, utcnow(), game_id),
                )
            else:
                cur.execute("UPDATE games SET state=? WHERE id=?", (state, game_id))

    def set_winner(self, game_id: int, player_id: int) -> None:
        with self.write() as cur:
            cur.execute(
                "UPDATE games SET winner_id=?, state=?, finished_at=? WHERE id=?",
                (player_id, FINISHED, utcnow(), game_id),
            )

    # -- players ------------------------------------------------------------

    def add_player(
        self,
        game_id: int,
        name: Optional[str],
        telegram_id: Optional[int] = None,
    ) -> Player:
        with self.write() as cur:
            cur.execute(
                "INSERT INTO players (game_id, name, token, telegram_id, joined_at)"
                " VALUES (?,?,?,?,?)",
                (game_id, name, new_token(), telegram_id, utcnow()),
            )
            player_id = cur.lastrowid
        return self.get_player(player_id)  # type: ignore[return-value]

    def get_player(self, player_id: int) -> Optional[Player]:
        row = self._query_one("SELECT * FROM players WHERE id=?", (player_id,))
        return _player(row) if row else None

    def players(self, game_id: int) -> List[Player]:
        return [
            _player(r)
            for r in self._query("SELECT * FROM players WHERE game_id=? ORDER BY id", (game_id,))
        ]

    def alive_players(self, game_id: int) -> List[Player]:
        return [p for p in self.players(game_id) if p.alive]

    def player_by_telegram(self, game_id: int, telegram_id: int) -> Optional[Player]:
        row = self._query_one(
            "SELECT * FROM players WHERE game_id=? AND telegram_id=?", (game_id, telegram_id)
        )
        return _player(row) if row else None

    def player_by_token(self, token: str) -> Optional[Player]:
        row = self._query_one("SELECT * FROM players WHERE token=?", (token,))
        return _player(row) if row else None

    def update_player(self, player_id: int, **fields) -> None:
        allowed = {"name", "word", "alive", "target_id", "mission_word", "eliminated_at", "telegram_id"}
        bad = set(fields) - allowed
        if bad:
            raise ValueError(f"Cannot update unknown player fields: {sorted(bad)}")
        if not fields:
            return
        sets = ", ".join(f"{k}=?" for k in fields)
        with self.write() as cur:
            cur.execute(
                f"UPDATE players SET {sets} WHERE id=?",
                (*[_sqlvalue(v) for v in fields.values()], player_id),
            )

    def delete_player(self, player_id: int) -> None:
        with self.write() as cur:
            cur.execute("DELETE FROM reports WHERE reporter_id=? OR target_id=?", (player_id, player_id))
            cur.execute("DELETE FROM players WHERE id=?", (player_id,))

    def clear_missions(self, game_id: int) -> None:
        """Wipe every mission (used by a pre-play re-roll)."""
        with self.write() as cur:
            cur.execute(
                "UPDATE players SET target_id=NULL, mission_word=NULL, alive=1, eliminated_at=NULL"
                " WHERE game_id=?",
                (game_id,),
            )
            cur.execute(
                "UPDATE reports SET state=? WHERE game_id=? AND state=?",
                (CANCELLED, game_id, PENDING),
            )

    def write_missions(self, missions: Dict[int, tuple]) -> None:
        """Persist `{player_id: (target_id, word)}` in a single transaction."""
        with self.write() as cur:
            for player_id, (target_id, word) in missions.items():
                cur.execute(
                    "UPDATE players SET target_id=?, mission_word=? WHERE id=?",
                    (target_id, word, player_id),
                )

    # -- reports ------------------------------------------------------------

    def add_report(self, game_id: int, reporter_id: int, target_id: int, word: str) -> int:
        with self.write() as cur:
            cur.execute(
                "INSERT INTO reports (game_id, reporter_id, target_id, word, state, created_at)"
                " VALUES (?,?,?,?,?,?)",
                (game_id, reporter_id, target_id, word, PENDING, utcnow()),
            )
            return int(cur.lastrowid)

    def get_report(self, report_id: int) -> Optional[Report]:
        row = self._query_one(
            "SELECT r.*, rp.name AS reporter_name, tp.name AS target_name"
            " FROM reports r"
            " JOIN players rp ON rp.id = r.reporter_id"
            " JOIN players tp ON tp.id = r.target_id"
            " WHERE r.id=?",
            (report_id,),
        )
        return _report(row) if row else None

    def reports(self, game_id: int, state: Optional[str] = None) -> List[Report]:
        sql = (
            "SELECT r.*, rp.name AS reporter_name, tp.name AS target_name"
            " FROM reports r"
            " JOIN players rp ON rp.id = r.reporter_id"
            " JOIN players tp ON tp.id = r.target_id"
            " WHERE r.game_id=?"
        )
        args: List = [game_id]
        if state:
            sql += " AND r.state=?"
            args.append(state)
        sql += " ORDER BY r.id"
        return [_report(r) for r in self._query(sql, args)]

    def pending_report_for(self, game_id: int, reporter_id: int, target_id: int) -> Optional[Report]:
        row = self._query_one(
            "SELECT r.*, rp.name AS reporter_name, tp.name AS target_name"
            " FROM reports r"
            " JOIN players rp ON rp.id = r.reporter_id"
            " JOIN players tp ON tp.id = r.target_id"
            " WHERE r.game_id=? AND r.reporter_id=? AND r.target_id=? AND r.state=?"
            " ORDER BY r.id DESC LIMIT 1",
            (game_id, reporter_id, target_id, PENDING),
        )
        return _report(row) if row else None

    def set_report_state(
        self,
        report_id: int,
        state: str,
        confirmed_by: Optional[int] = None,
    ) -> None:
        with self.write() as cur:
            cur.execute(
                "UPDATE reports SET state=?, confirmed_by=?, confirmed_at=? WHERE id=?",
                (state, confirmed_by, utcnow() if state == CONFIRMED else None, report_id),
            )

    def cancel_pending_reports_involving(self, game_id: int, player_id: int, except_id: int) -> None:
        with self.write() as cur:
            cur.execute(
                "UPDATE reports SET state=? WHERE game_id=? AND state=? AND id<>?"
                " AND (reporter_id=? OR target_id=?)",
                (CANCELLED, game_id, PENDING, except_id, player_id, player_id),
            )

    # -- events / feed ------------------------------------------------------

    def add_event(self, game_id: int, kind: str, message: str) -> None:
        with self.write() as cur:
            cur.execute(
                "INSERT INTO events (game_id, kind, message, created_at) VALUES (?,?,?,?)",
                (game_id, kind, message, utcnow()),
            )

    def feed(self, game_id: int, limit: int = 100) -> List[FeedItem]:
        rows = self._query(
            "SELECT * FROM events WHERE game_id=? ORDER BY id DESC LIMIT ?", (game_id, limit)
        )
        return [FeedItem(r["id"], r["kind"], r["message"], r["created_at"]) for r in rows]

    # -- settings -----------------------------------------------------------

    def set_setting(self, game_id: int, key: str, value: Optional[str]) -> None:
        with self.write() as cur:
            cur.execute(
                "INSERT INTO settings (game_id, key, value) VALUES (?,?,?)"
                " ON CONFLICT(game_id, key) DO UPDATE SET value=excluded.value",
                (game_id, key, value),
            )

    def get_setting(self, game_id: int, key: str) -> Optional[str]:
        row = self._query_one("SELECT value FROM settings WHERE game_id=? AND key=?", (game_id, key))
        return row["value"] if row else None


# -- row -> dataclass helpers ----------------------------------------------


def _sqlvalue(value):
    return int(value) if isinstance(value, bool) else value


def _game(row: sqlite3.Row) -> Game:
    return Game(
        id=row["id"],
        name=row["name"],
        state=row["state"],
        winner_id=row["winner_id"],
        created_at=row["created_at"],
        started_at=row["started_at"],
        finished_at=row["finished_at"],
    )


def _player(row: sqlite3.Row) -> Player:
    return Player(
        id=row["id"],
        game_id=row["game_id"],
        name=row["name"],
        token=row["token"],
        telegram_id=row["telegram_id"],
        word=row["word"],
        alive=bool(row["alive"]),
        target_id=row["target_id"],
        mission_word=row["mission_word"],
        joined_at=row["joined_at"],
        eliminated_at=row["eliminated_at"],
    )


def _report(row: sqlite3.Row) -> Report:
    return Report(
        id=row["id"],
        game_id=row["game_id"],
        reporter_id=row["reporter_id"],
        reporter_name=row["reporter_name"] or f"Player #{row['reporter_id']}",
        target_id=row["target_id"],
        target_name=row["target_name"] or f"Player #{row['target_id']}",
        word=row["word"],
        state=row["state"],
        created_at=row["created_at"],
        confirmed_by=row["confirmed_by"],
        confirmed_at=row["confirmed_at"],
    )
