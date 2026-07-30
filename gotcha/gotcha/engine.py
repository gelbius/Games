"""The game engine: every rule of Gotcha lives here, and nowhere else.

The Telegram bot and the web app are thin shells around this class. That is what
makes the rules testable without a phone or a browser (see `tests/`) and what
guarantees the two interfaces can never disagree about the state of the game.

Secrecy contract of this module
-------------------------------
* `current_status()` returns public information only: names, alive/dead, counts,
  the announcement feed. There is no method that returns the whole assignment
  map, so no admin screen can be built that shows it.
* `get_mission(player_id)` returns one player's mission, for that player.
* `generate_assignments()` returns the list of missions ONCE, so the caller can
  DM them out. Interfaces must deliver and drop it - never print, never log.
"""

from __future__ import annotations

import random
from typing import Dict, List, Optional

from .assignments import (
    AssignmentError,
    build_target_cycle,
    build_word_derangement,
    verify_assignments,
)
from .models import (
    ACTIVE,
    CANCELLED,
    CONFIRMED,
    PENDING,
    ConfirmResult,
    Game,
    Mission,
    MissionDelivery,
    Player,
    PublicPlayer,
    Report,
    Status,
)
from .storage import Storage, utcnow


class GotchaError(Exception):
    """Base class for problems worth showing the user verbatim."""


class RuleViolation(GotchaError):
    """The action was understood but is not allowed right now."""


# `AssignmentError` is raised by the maths layer; re-exported so callers can
# catch a single family of errors.
AssignmentError = AssignmentError  # noqa: PLW0127


class GotchaEngine:
    def __init__(self, storage: Storage) -> None:
        self.storage = storage

    # ------------------------------------------------------------------
    # Setup
    # ------------------------------------------------------------------

    def create_game(self, name: str = "Gotcha") -> Game:
        return self.storage.create_game(name)

    def current_game(self) -> Optional[Game]:
        """The most recently created game (this app runs one game at a time)."""
        return self.storage.latest_game()

    def get_or_create_game(self, name: str = "Gotcha") -> Game:
        game = self.storage.latest_game()
        return game if game else self.create_game(name)

    def add_player(
        self,
        game_id: int,
        name: Optional[str] = None,
        telegram_id: Optional[int] = None,
    ) -> Player:
        """Add someone to the lobby. Returns the player, including their token.

        Joining twice from the same Telegram account is not an error: you get
        your existing player row back, so `/join` is safe to repeat.
        """
        game = self._game(game_id)
        if telegram_id is not None:
            existing = self.storage.player_by_telegram(game_id, telegram_id)
            if existing:
                if name and not existing.name:
                    self.storage.update_player(existing.id, name=name)
                    return self._player(existing.id)
                return existing
        if not game.is_lobby:
            raise RuleViolation("The game has already started - too late to join.")
        if name:
            self._require_free_name(game_id, name)
        player = self.storage.add_player(game_id, name=name, telegram_id=telegram_id)
        if name:
            self.storage.add_event(game_id, "joined", f"✅ {name} joined the game.")
        return player

    def set_name(self, player_id: int, name: str) -> Player:
        """Used by the web flow, where a magic link is issued before the name."""
        player = self._player(player_id)
        name = name.strip()
        if not name:
            raise RuleViolation("Please give a name people will recognise.")
        if len(name) > 40:
            raise RuleViolation("That name is too long (40 characters max).")
        game = self._game(player.game_id)
        if not game.is_lobby and (player.name or "") != name:
            raise RuleViolation("Names are locked once the game has started.")
        self._require_free_name(player.game_id, name, ignore_player_id=player_id)
        first_time = not player.name
        self.storage.update_player(player_id, name=name)
        if first_time:
            self.storage.add_event(player.game_id, "joined", f"✅ {name} joined the game.")
        return self._player(player_id)

    def submit_word(self, player_id: int, word: str) -> Player:
        """Store a player's secret word. Allowed (and re-editable) until start."""
        player = self._player(player_id)
        game = self._game(player.game_id)
        if not game.is_lobby:
            raise RuleViolation("Words are locked in - the game has already started.")
        word = " ".join(word.strip().split())
        if not word:
            raise RuleViolation("Send me an actual word.")
        if len(word) > 40:
            raise RuleViolation("Keep it to 40 characters or less.")
        if len(word.split()) > 3:
            raise RuleViolation("One word, or a very short phrase (3 words max).")
        self.storage.update_player(player_id, word=word)
        return self._player(player_id)

    def remove_player(self, game_id: int, player_id: int) -> str:
        """Admin: drop a no-show. Only in the lobby, before any assignments."""
        game = self._game(game_id)
        if not game.is_lobby:
            raise RuleViolation(
                "Players can only be removed before the game starts. "
                "Use a re-roll if you need to rebuild the chain."
            )
        player = self._player(player_id)
        name = player.display_name
        self.storage.delete_player(player_id)
        self.storage.add_event(game_id, "note", f"➖ {name} was removed from the lobby.")
        return name

    # ------------------------------------------------------------------
    # Generation
    # ------------------------------------------------------------------

    def generate_assignments(
        self,
        game_id: int,
        rng: Optional[random.Random] = None,
    ) -> List[MissionDelivery]:
        """Build the chain and the words, save them, and return the missions.

        Raises before writing anything if the roster is not ready. The safety
        checks in `verify_assignments` run twice: once on the freshly generated
        maps, and once more on what actually came back out of the database.
        """
        game = self._game(game_id)
        if game.is_finished:
            raise RuleViolation("That game is over. Create a new one.")
        players = self.storage.players(game_id)
        if game.is_active and any(not p.alive for p in players):
            raise RuleViolation(
                "Somebody has already been eliminated - re-rolling now would break the game."
            )

        rng = rng or random.SystemRandom()

        unnamed = [p for p in players if not p.name]
        if unnamed:
            raise RuleViolation(f"{len(unnamed)} invited player(s) have not signed in yet.")
        if len(players) < 2:
            raise RuleViolation("You need at least 2 players.")
        not_ready = [p.display_name for p in players if not p.has_word]
        if not_ready:
            raise RuleViolation("Still waiting on a word from: " + ", ".join(sorted(not_ready)))

        ids = [p.id for p in players]
        own_words: Dict[int, str] = {p.id: p.word or "" for p in players}

        # 1. who hunts whom - ONE loop through everybody (Sattolo, see assignments.py)
        targets = build_target_cycle(ids, rng)
        # 2. which word each player must extract - a derangement, no own words
        words = build_word_derangement(ids, own_words, rng)
        # 3. refuse to continue unless both properties hold
        verify_assignments(targets, own_words, words)

        self.storage.write_missions({pid: (targets[pid], words[pid]) for pid in ids})

        # Re-read from disk and check again: this catches a persistence bug as
        # well as a maths bug, before a single message goes out.
        self._verify_persisted(game_id)

        if not game.is_active:
            self.storage.set_game_state(game_id, ACTIVE)
            self.storage.add_event(
                game_id, "started", f"🎯 The hunt is on! {len(players)} players in the loop."
            )
        else:
            self.storage.add_event(game_id, "note", "🔄 Missions were re-rolled. Check your DMs.")

        by_id = {p.id: p for p in players}
        return [
            MissionDelivery(
                target_id=targets[p.id],
                target_name=by_id[targets[p.id]].display_name,
                word=words[p.id],
                player_id=p.id,
                player_name=p.display_name,
                telegram_id=p.telegram_id,
                token=p.token,
            )
            for p in players
        ]

    def _verify_persisted(self, game_id: int) -> None:
        """Read the saved missions back and re-run the safety checks."""
        players = self.storage.alive_players(game_id)
        targets = {}
        assigned = {}
        own = {}
        for p in players:
            if p.target_id is None or not p.mission_word:
                raise AssignmentError(f"Mission for {p.display_name} was not saved.")
            targets[p.id] = p.target_id
            assigned[p.id] = p.mission_word
            own[p.id] = p.word or ""
        verify_assignments(targets, own, assigned)

    # ------------------------------------------------------------------
    # Play
    # ------------------------------------------------------------------

    def get_mission(self, player_id: int) -> Optional[Mission]:
        """One player's current target + word, or None if they have no mission."""
        player = self._player(player_id)
        if player.target_id is None or not player.mission_word:
            return None
        if not player.alive:
            return None
        target = self._player(player.target_id)
        return Mission(
            target_id=target.id,
            target_name=target.display_name,
            word=player.mission_word,
        )

    def find_player_by_name(self, game_id: int, name: str) -> Player:
        """Resolve a typed name: exact match first, then unique prefix match."""
        needle = " ".join(name.strip().lower().split())
        if not needle:
            raise RuleViolation("Who? Give me a name.")
        players = [p for p in self.storage.players(game_id) if p.name]
        exact = [p for p in players if (p.name or "").lower() == needle]
        if len(exact) == 1:
            return exact[0]
        partial = [p for p in players if (p.name or "").lower().startswith(needle)]
        if len(partial) == 1:
            return partial[0]
        if len(partial) > 1:
            raise RuleViolation(
                "That matches more than one player: " + ", ".join(p.display_name for p in partial)
            )
        raise RuleViolation(f"No player called {name!r} in this game.")

    def report_gotcha(self, game_id: int, reporter_id: int, target_name: str) -> Report:
        """Claim a kill. Only valid against your CURRENT target.

        Idempotent: reporting the same target twice returns the existing pending
        report rather than creating a second one.
        """
        game = self._game(game_id)
        if not game.is_active:
            raise RuleViolation(
                "The game is not running." if not game.is_finished else "The game is already over."
            )
        reporter = self._player(reporter_id)
        if not reporter.alive:
            raise RuleViolation("You are out of the game - no more gotchas for you.")
        mission = self.get_mission(reporter_id)
        if mission is None:
            raise RuleViolation("You do not have a mission yet.")

        named = self.find_player_by_name(game_id, target_name)
        if named.id != mission.target_id:
            # Deliberately vague: telling them WHO their target is here would
            # let anyone fish for other people's assignments.
            raise RuleViolation(f"{named.display_name} is not your target. Check /mission.")
        if not named.alive:
            raise RuleViolation(f"{named.display_name} is already out.")

        existing = self.storage.pending_report_for(game_id, reporter_id, named.id)
        if existing:
            return existing
        report_id = self.storage.add_report(game_id, reporter_id, named.id, mission.word)
        return self.storage.get_report(report_id)  # type: ignore[return-value]

    def cancel_gotcha(self, game_id: int, report_id: int, requester_id: int) -> None:
        """Withdraw your own unconfirmed claim (typo, jumped the gun, etc.)."""
        report = self._report(report_id)
        if report.game_id != game_id:
            raise RuleViolation("That claim belongs to a different game.")
        if report.reporter_id != requester_id:
            raise RuleViolation("Only the person who claimed it can withdraw it.")
        if report.state != PENDING:
            raise RuleViolation("That claim is no longer pending.")
        self.storage.set_report_state(report_id, CANCELLED)

    def pending_reports(self, game_id: int) -> List[Report]:
        """Claims awaiting a witness.

        Visible to players because somebody has to confirm them. This is the one
        place where a hunter->target link is briefly disclosed; it becomes public
        knowledge a second later anyway, since eliminations are announced.
        """
        return self.storage.reports(game_id, PENDING)

    def confirmable_reports(self, game_id: int, confirmer_id: int) -> List[Report]:
        """Pending claims this player is allowed to confirm (i.e. not their own)."""
        return [r for r in self.pending_reports(game_id) if r.reporter_id != confirmer_id]

    def confirm_gotcha(self, game_id: int, report_id: int, confirmer_id: int) -> ConfirmResult:
        """Witness a claim: eliminate the victim and pass their mission on.

        THE INHERITANCE RULE (this is the heart of the game)
        ---------------------------------------------------
        The hunter takes over the victim's *entire* mission - the victim's target
        AND the victim's word. In chain terms the victim is spliced out:

            hunter -> victim -> next        becomes     hunter -> next

        Because the chain started as one single loop (Sattolo, see
        assignments.py), splicing keeps it one single loop, just shorter. So the
        chain can never fragment, and "my new target is me" can only happen when
        the loop is down to one player - the win.

        Anyone except the reporter may confirm, including eliminated players
        (being dead does not stop you from having witnessed a gotcha).
        Idempotent: confirming an already-confirmed claim reports the same
        outcome instead of eliminating anybody twice.
        """
        game = self._game(game_id)
        report = self._report(report_id)
        if report.game_id != game_id:
            raise RuleViolation("That claim belongs to a different game.")

        victim = self._player(report.target_id)
        hunter = self._player(report.reporter_id)

        # --- idempotency: someone already confirmed this exact claim ---------
        if report.state == CONFIRMED:
            status = self.current_status(game_id)
            return ConfirmResult(
                already_confirmed=True,
                victim_id=victim.id,
                victim_name=victim.display_name,
                hunter_id=hunter.id,
                hunter_name=hunter.display_name,
                alive_count=status.alive_count,
                announcement=f"{victim.display_name} is already out.",
                new_mission=None,
                winner_id=game.winner_id,
                winner_name=status.winner_name,
            )
        if report.state == CANCELLED:
            raise RuleViolation("That claim was withdrawn.")
        if not game.is_active:
            raise RuleViolation("The game is not running.")

        # --- who may confirm -------------------------------------------------
        if confirmer_id == report.reporter_id:
            raise RuleViolation("You cannot confirm your own gotcha. Get a witness.")
        confirmer = self._player(confirmer_id)
        if confirmer.game_id != game_id:
            raise RuleViolation("You are not in this game.")

        # --- the claim must still be live ------------------------------------
        if not hunter.alive:
            self.storage.set_report_state(report_id, CANCELLED)
            raise RuleViolation(f"{hunter.display_name} is out - that claim is void.")
        if not victim.alive:
            self.storage.set_report_state(report_id, CANCELLED)
            raise RuleViolation(f"{victim.display_name} is already out.")
        if hunter.target_id != victim.id:
            self.storage.set_report_state(report_id, CANCELLED)
            raise RuleViolation("That claim is stale: the hunter's target has changed.")

        # --- eliminate + inherit --------------------------------------------
        inherited_target_id = victim.target_id
        inherited_word = victim.mission_word
        if inherited_target_id is None or not inherited_word:
            raise AssignmentError(
                f"{victim.display_name} has no mission to inherit - refusing to continue."
            )

        self.storage.update_player(victim.id, alive=False, eliminated_at=utcnow())
        # The victim keeps no mission: it now belongs to the hunter.
        self.storage.update_player(victim.id, target_id=None, mission_word=None)
        self.storage.update_player(
            hunter.id, target_id=inherited_target_id, mission_word=inherited_word
        )
        self.storage.set_report_state(report_id, CONFIRMED, confirmed_by=confirmer_id)
        # Any other pending claim that involved the victim is now meaningless.
        self.storage.cancel_pending_reports_involving(game_id, victim.id, except_id=report_id)

        alive = self.storage.alive_players(game_id)
        announcement = f"💀 {victim.display_name} is out! ({len(alive)} left)"
        self.storage.add_event(game_id, "elimination", announcement)

        # --- win check: the hunter inherited a mission to hunt themselves ----
        if inherited_target_id == hunter.id:
            if len(alive) != 1:  # pragma: no cover - guarded by the cycle invariant
                raise AssignmentError(
                    f"Chain corrupted: {hunter.display_name} inherited themselves with "
                    f"{len(alive)} players still alive."
                )
            self.storage.update_player(hunter.id, target_id=None, mission_word=None)
            self.storage.set_winner(game_id, hunter.id)
            win_message = f"🏆 {hunter.display_name} wins Gotcha!"
            self.storage.add_event(game_id, "winner", win_message)
            return ConfirmResult(
                already_confirmed=False,
                victim_id=victim.id,
                victim_name=victim.display_name,
                hunter_id=hunter.id,
                hunter_name=hunter.display_name,
                alive_count=1,
                announcement=announcement + "\n" + win_message,
                new_mission=None,
                winner_id=hunter.id,
                winner_name=hunter.display_name,
            )

        new_target = self._player(inherited_target_id)
        return ConfirmResult(
            already_confirmed=False,
            victim_id=victim.id,
            victim_name=victim.display_name,
            hunter_id=hunter.id,
            hunter_name=hunter.display_name,
            alive_count=len(alive),
            announcement=announcement,
            new_mission=MissionDelivery(
                target_id=new_target.id,
                target_name=new_target.display_name,
                word=inherited_word,
                player_id=hunter.id,
                player_name=hunter.display_name,
                telegram_id=hunter.telegram_id,
                token=hunter.token,
            ),
        )

    # ------------------------------------------------------------------
    # Public views
    # ------------------------------------------------------------------

    def current_status(self, game_id: int, feed_limit: int = 50) -> Status:
        """The public scoreboard - safe to show to anyone, admin included."""
        game = self._game(game_id)
        players = self.storage.players(game_id)
        public = [
            PublicPlayer(id=p.id, name=p.display_name, alive=p.alive, ready=p.has_word)
            for p in players
        ]
        alive = [p for p in public if p.alive]
        winner = self.storage.get_player(game.winner_id) if game.winner_id else None
        return Status(
            game=game,
            players=public,
            alive_count=len(alive),
            eliminated_count=len(public) - len(alive),
            joined_count=len([p for p in players if p.name]),
            ready_count=len([p for p in players if p.has_word and p.name]),
            winner_name=winner.display_name if winner else None,
            feed=self.storage.feed(game_id, feed_limit),
            pending_count=len(self.pending_reports(game_id)),
        )

    def winner(self, game_id: int) -> Optional[Player]:
        game = self._game(game_id)
        if not game.winner_id:
            return None
        return self.storage.get_player(game.winner_id)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _game(self, game_id: int) -> Game:
        game = self.storage.get_game(game_id)
        if not game:
            raise GotchaError("No such game.")
        return game

    def _player(self, player_id: int) -> Player:
        player = self.storage.get_player(player_id)
        if not player:
            raise GotchaError("No such player.")
        return player

    def _report(self, report_id: int) -> Report:
        report = self.storage.get_report(report_id)
        if not report:
            raise RuleViolation("No such gotcha claim.")
        return report

    def _require_free_name(
        self, game_id: int, name: str, ignore_player_id: Optional[int] = None
    ) -> None:
        needle = name.strip().lower()
        for p in self.storage.players(game_id):
            if p.id == ignore_player_id or not p.name:
                continue
            if p.name.lower() == needle:
                raise RuleViolation(
                    f"There is already a {p.name} in this game - pick a nickname to tell you apart."
                )
