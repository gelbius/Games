"""Plain data containers handed between the storage layer, engine and interfaces.

Two rules encoded here:

* `PublicPlayer` / `Status` / `FeedItem` contain ONLY information that everyone
  is allowed to see (names, alive/dead, counts, the announcement feed).
* Anything secret (a target, a word) only ever appears in `Mission` /
  `MissionDelivery`, which the engine returns for exactly one player at a time
  (or, at generation, as a one-shot list that the interface DMs out and drops).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

LOBBY = "lobby"
ACTIVE = "active"
FINISHED = "finished"

PENDING = "pending"
CONFIRMED = "confirmed"
CANCELLED = "cancelled"


@dataclass(frozen=True)
class Game:
    id: int
    name: str
    state: str
    winner_id: Optional[int]
    created_at: str
    started_at: Optional[str]
    finished_at: Optional[str]

    @property
    def is_lobby(self) -> bool:
        return self.state == LOBBY

    @property
    def is_active(self) -> bool:
        return self.state == ACTIVE

    @property
    def is_finished(self) -> bool:
        return self.state == FINISHED


@dataclass(frozen=True)
class Player:
    """Internal player row. `word`/`target_id`/`mission_word` are SECRET.

    Only the engine touches those fields; nothing that reaches an admin screen
    or a log line is built from them.
    """

    id: int
    game_id: int
    name: Optional[str]
    token: str
    telegram_id: Optional[int]
    word: Optional[str]
    alive: bool
    target_id: Optional[int]
    mission_word: Optional[str]
    joined_at: str
    eliminated_at: Optional[str]

    @property
    def has_word(self) -> bool:
        return bool((self.word or "").strip())

    @property
    def display_name(self) -> str:
        return self.name or f"Player #{self.id}"


@dataclass(frozen=True)
class PublicPlayer:
    """What anybody, including the admin, may see about a player."""

    id: int
    name: str
    alive: bool
    ready: bool  # has joined and submitted a word (not *which* word)
    claimed: bool = True  # False = an invite link nobody has opened yet


@dataclass(frozen=True)
class Mission:
    """One player's current secret mission."""

    target_id: int
    target_name: str
    word: str


@dataclass(frozen=True)
class MissionDelivery(Mission):
    """A mission plus just enough routing info for an interface to deliver it."""

    player_id: int
    player_name: str
    telegram_id: Optional[int]
    token: str


@dataclass(frozen=True)
class Report:
    """A claimed gotcha awaiting confirmation by any other player."""

    id: int
    game_id: int
    reporter_id: int
    reporter_name: str
    target_id: int
    target_name: str
    word: str
    state: str
    created_at: str
    confirmed_by: Optional[int]
    confirmed_at: Optional[str]


@dataclass(frozen=True)
class FeedItem:
    id: int
    kind: str
    message: str
    created_at: str


@dataclass(frozen=True)
class Status:
    """The public scoreboard. Contains no assignment information whatsoever."""

    game: Game
    players: List[PublicPlayer]
    alive_count: int
    eliminated_count: int
    joined_count: int
    ready_count: int
    winner_name: Optional[str]
    feed: List[FeedItem] = field(default_factory=list)
    pending_count: int = 0


@dataclass(frozen=True)
class ConfirmResult:
    """Everything an interface needs to react to a confirmed gotcha."""

    already_confirmed: bool
    victim_id: int
    victim_name: str
    hunter_id: int
    hunter_name: str
    alive_count: int
    announcement: str
    new_mission: Optional[MissionDelivery]  # for the hunter; None once game over
    winner_id: Optional[int] = None
    winner_name: Optional[str] = None

    @property
    def game_over(self) -> bool:
        return self.winner_id is not None
