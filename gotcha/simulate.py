#!/usr/bin/env python3
"""Play a whole game against fake players, to prove the loop always resolves.

    python3 simulate.py                 # one 16-player game, verbose
    python3 simulate.py --players 8
    python3 simulate.py --repeat 500 --quiet   # stress test: 500 games

What it does: creates a game in a throwaway in-memory database, fills it with
fake players and words, generates the missions, then repeatedly picks a random
living hunter, reports a gotcha on their *actual* current target, and has a
random other player confirm it. After every single confirmation it re-checks
that the remaining hunters still form ONE unbroken loop.

If the maths were wrong - several small loops instead of one - this script would
stop with "no living player has a valid target" instead of crowning a winner.
"""

from __future__ import annotations

import argparse
import random
import sys

from gotcha.assignments import is_single_cycle
from gotcha.engine import GotchaEngine
from gotcha.storage import Storage

FAKE_NAMES = [
    "Ana", "Ben", "Cleo", "Dev", "Esme", "Finn", "Gus", "Hana",
    "Iris", "Jonas", "Kira", "Liam", "Mina", "Noor", "Otto", "Pia",
    "Quinn", "Rae", "Sami", "Tess", "Umi", "Vik", "Wren", "Xan",
    "Yuki", "Zane", "Ada", "Bo", "Cass", "Dara", "Eli", "Fay",
]

FAKE_WORDS = [
    "pineapple", "hydrangea", "moist", "kerfuffle", "bamboozle", "penguin",
    "aubergine", "trombone", "wombat", "spatula", "cardigan", "meringue",
    "flamingo", "gazebo", "yoghurt", "kayak", "tapioca", "walrus",
    "clementine", "harmonica", "pumpernickel", "sassafras", "zeppelin",
    "quokka", "linoleum", "marzipan", "narwhal", "obelisk", "paprika",
    "rutabaga", "semaphore", "tambourine",
]


def check_chain_is_one_loop(engine: GotchaEngine, game_id: int) -> None:
    """The living players must always form a single unbroken hunting loop."""
    alive = engine.storage.alive_players(game_id)
    if len(alive) <= 1:
        return
    targets = {p.id: p.target_id for p in alive}
    if any(t is None for t in targets.values()):
        raise SystemExit("BROKEN: a living player has no target.")
    if not is_single_cycle(targets):  # type: ignore[arg-type]
        raise SystemExit(f"BROKEN: {len(alive)} living players are not in one single loop.")


def play_one_game(n_players: int, rng: random.Random, verbose: bool = True) -> str:
    storage = Storage(":memory:")
    engine = GotchaEngine(storage)
    game = engine.create_game(f"Simulated {n_players}-player game")

    # --- setup: everybody joins and submits a word ----------------------
    words = (FAKE_WORDS * ((n_players // len(FAKE_WORDS)) + 1))[:n_players]
    names = (FAKE_NAMES * ((n_players // len(FAKE_NAMES)) + 1))[:n_players]
    for i in range(n_players):
        name = names[i] if names.count(names[i]) == 1 else f"{names[i]}{i}"
        player = engine.add_player(game.id, name=name, telegram_id=1000 + i)
        engine.submit_word(player.id, words[i])

    # --- generation -----------------------------------------------------
    missions = engine.generate_assignments(game.id, rng=rng)
    if verbose:
        print(f"\n{n_players} players joined. Missions generated and DM'd privately.")
        print("(The simulator does not print the assignment map - same as the real game.)")
        # Sanity print that leaks nothing: only the shape of the chain.
        print(f"Chain check: single loop through all {len(missions)} players ✔")
        print("\n--- play ---")
    check_chain_is_one_loop(engine, game.id)

    elimination_order = []
    rounds = 0
    while True:
        status = engine.current_status(game.id)
        if status.game.is_finished:
            break
        rounds += 1
        if rounds > n_players * 5:  # pragma: no cover - would mean a stuck game
            raise SystemExit("BROKEN: game did not finish in a sane number of rounds.")

        alive = engine.storage.alive_players(game.id)
        hunters = [p for p in alive if p.target_id is not None]
        if not hunters:
            raise SystemExit("BROKEN: no living player has a valid target (dead end!).")

        hunter = rng.choice(hunters)
        mission = engine.get_mission(hunter.id)
        assert mission is not None

        report = engine.report_gotcha(game.id, hunter.id, mission.target_name)

        # Anyone but the reporter may confirm - including already-eliminated
        # players, which the real game also allows.
        witnesses = [p for p in engine.storage.players(game.id) if p.id != hunter.id]
        witness = rng.choice(witnesses)
        result = engine.confirm_gotcha(game.id, report.id, witness.id)

        elimination_order.append(result.victim_name)
        if verbose:
            line = f"{len(elimination_order):>2}. {result.announcement.splitlines()[0]}"
            print(f"{line}   (confirmed by {witness.display_name})")

        # Double-confirm the same claim: must be a no-op, never a second kill.
        again = engine.confirm_gotcha(game.id, report.id, witness.id)
        assert again.already_confirmed, "duplicate confirm was not idempotent"

        check_chain_is_one_loop(engine, game.id)

    winner = engine.winner(game.id)
    assert winner is not None, "game finished with no winner"
    final = engine.current_status(game.id)
    assert final.alive_count == 1, f"expected 1 survivor, found {final.alive_count}"
    assert len(elimination_order) == n_players - 1

    if verbose:
        print("\n--- result ---")
        print("Elimination order: " + " → ".join(elimination_order))
        print(f"🏆 Winner: {winner.display_name}")
        print(f"Players: {n_players} | eliminations: {len(elimination_order)} | survivors: 1")
    storage.close()
    return winner.display_name


def main() -> int:
    parser = argparse.ArgumentParser(description="Simulate a full game of Gotcha.")
    parser.add_argument("--players", type=int, default=16, help="how many fake players (default 16)")
    parser.add_argument("--repeat", type=int, default=1, help="how many games to play")
    parser.add_argument("--seed", type=int, default=None, help="fix the randomness for a repeatable run")
    parser.add_argument("--quiet", action="store_true", help="only print the summary")
    args = parser.parse_args()

    if args.players < 2:
        print("Need at least 2 players.", file=sys.stderr)
        return 2

    rng = random.Random(args.seed)
    winners = []
    for i in range(args.repeat):
        verbose = not args.quiet and args.repeat <= 3
        winners.append(play_one_game(args.players, rng, verbose=verbose))

    if args.repeat > 1 or args.quiet:
        print(
            f"\n{args.repeat} game(s) of {args.players} players: "
            f"{len(winners)} finished with exactly one winner, 0 dead ends."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
