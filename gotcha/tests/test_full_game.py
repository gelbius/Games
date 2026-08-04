"""End-to-end: a full simulated game must always end with exactly one winner."""

import random

import pytest
from conftest import seed_lobby

from gotcha.assignments import is_single_cycle


def play_to_the_end(engine, game_id, rng):
    """Auto-play random *valid* gotchas until the game declares a winner."""
    eliminated = []
    guard = 0
    while not engine.current_status(game_id).game.is_finished:
        guard += 1
        assert guard < 500, "game never finished - dead end"

        alive = engine.storage.alive_players(game_id)
        hunters = [p for p in alive if p.target_id is not None]
        assert hunters, "dead end: nobody alive has a target"

        # invariant: the living players are always one unbroken loop
        if len(alive) > 1:
            assert is_single_cycle({p.id: p.target_id for p in alive})

        hunter = rng.choice(hunters)
        mission = engine.get_mission(hunter.id)
        report = engine.report_gotcha(game_id, hunter.id, mission.target_name)
        witness = rng.choice([p for p in engine.storage.players(game_id) if p.id != hunter.id])
        result = engine.confirm_gotcha(game_id, report.id, witness.id)
        eliminated.append(result.victim_name)
    return eliminated


@pytest.mark.parametrize("n", [2, 3, 4, 7, 16, 30])
def test_full_game_ends_with_exactly_one_winner(engine, n):
    rng = random.Random(20 + n)
    game, players = seed_lobby(engine, n)
    engine.generate_assignments(game.id, rng=rng)

    eliminated = play_to_the_end(engine, game.id, rng)

    status = engine.current_status(game.id)
    assert status.game.is_finished
    assert status.alive_count == 1
    assert status.eliminated_count == n - 1
    assert len(eliminated) == n - 1
    assert len(set(eliminated)) == n - 1, "somebody was eliminated twice"

    winner = engine.winner(game.id)
    assert winner is not None
    assert winner.display_name not in eliminated
    survivors = [p for p in status.players if p.alive]
    assert [s.name for s in survivors] == [winner.display_name]


def test_sixteen_player_game_many_times(engine_factory=None):
    """Repeat the real configuration a lot: 16 players, 200 games, no dead ends."""
    from gotcha.engine import GotchaEngine
    from gotcha.storage import Storage

    for trial in range(200):
        storage = Storage(":memory:")
        engine = GotchaEngine(storage)
        rng = random.Random(trial)
        game, _ = seed_lobby(engine, 16)
        engine.generate_assignments(game.id, rng=rng)
        eliminated = play_to_the_end(engine, game.id, rng)
        assert len(eliminated) == 15
        assert engine.current_status(game.id).alive_count == 1
        assert engine.winner(game.id) is not None
        storage.close()


def test_confirmations_in_a_scrambled_order_still_resolve(engine):
    """Several claims pending at once, confirmed out of order, still one winner."""
    rng = random.Random(99)
    game, players = seed_lobby(engine, 10)
    engine.generate_assignments(game.id, rng=rng)

    while not engine.current_status(game.id).game.is_finished:
        alive = engine.storage.alive_players(game.id)
        # Every living hunter files a claim before anyone confirms anything.
        for hunter in alive:
            mission = engine.get_mission(hunter.id)
            if mission:
                engine.report_gotcha(game.id, hunter.id, mission.target_name)

        pending = engine.pending_reports(game.id)
        rng.shuffle(pending)
        for report in pending:
            witness = rng.choice(
                [p for p in engine.storage.players(game.id) if p.id != report.reporter_id]
            )
            try:
                engine.confirm_gotcha(game.id, report.id, witness.id)
            except Exception as exc:  # stale/void claims are expected here
                assert "stale" in str(exc) or "already out" in str(exc) or "void" in str(exc) \
                    or "not running" in str(exc) or "withdrawn" in str(exc), str(exc)

    status = engine.current_status(game.id)
    assert status.alive_count == 1
    assert status.eliminated_count == 9
    assert engine.winner(game.id) is not None
