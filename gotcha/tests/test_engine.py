"""Rule tests for the engine: reporting, confirming, inheritance, secrecy."""

import pytest
from conftest import seed_lobby

from gotcha.engine import AssignmentError, RuleViolation
from gotcha.models import CONFIRMED, PENDING


# --- setup phase -----------------------------------------------------------


def test_join_and_word_submission(engine):
    game, players = seed_lobby(engine, 4)
    status = engine.current_status(game.id)
    assert status.joined_count == 4
    assert status.ready_count == 4
    assert status.game.is_lobby
    # The public status carries no words and no assignments.
    assert not hasattr(status.players[0], "word")


def test_joining_twice_is_harmless(engine):
    game = engine.create_game("g")
    first = engine.add_player(game.id, name="Ana", telegram_id=99)
    again = engine.add_player(game.id, name="Ana", telegram_id=99)
    assert first.id == again.id
    assert len(engine.storage.players(game.id)) == 1


def test_duplicate_names_are_rejected(engine):
    game = engine.create_game("g")
    engine.add_player(game.id, name="Ana", telegram_id=1)
    with pytest.raises(RuleViolation, match="already a Ana"):
        engine.add_player(game.id, name="ana", telegram_id=2)


def test_cannot_start_without_all_words(engine):
    game, players = seed_lobby(engine, 4, with_words=False)
    engine.submit_word(players[0].id, "cat")
    with pytest.raises(RuleViolation, match="Still waiting on a word"):
        engine.generate_assignments(game.id)


def test_admin_can_remove_a_noshow_before_start(engine):
    game, players = seed_lobby(engine, 4)
    engine.remove_player(game.id, players[3].id)
    assert engine.current_status(game.id).joined_count == 3
    engine.generate_assignments(game.id)
    assert engine.current_status(game.id).alive_count == 3


def test_cannot_remove_after_start(engine):
    game, players = seed_lobby(engine, 4)
    engine.generate_assignments(game.id)
    with pytest.raises(RuleViolation, match="only be removed before"):
        engine.remove_player(game.id, players[0].id)


def test_words_locked_after_start(engine):
    game, players = seed_lobby(engine, 4)
    engine.generate_assignments(game.id)
    with pytest.raises(RuleViolation, match="locked in"):
        engine.submit_word(players[0].id, "newword")


def test_reroll_allowed_before_any_elimination_only(engine):
    game, players = seed_lobby(engine, 6)
    first = {m.player_id: (m.target_id, m.word) for m in engine.generate_assignments(game.id)}
    second = {m.player_id: (m.target_id, m.word) for m in engine.generate_assignments(game.id)}
    assert set(first) == set(second)  # same roster, freshly rolled

    hunter = engine.storage.get_player(players[0].id)
    mission = engine.get_mission(hunter.id)
    report = engine.report_gotcha(game.id, hunter.id, mission.target_name)
    engine.confirm_gotcha(game.id, report.id, players[1].id if players[1].id != hunter.id else players[2].id)
    with pytest.raises(RuleViolation, match="already been eliminated"):
        engine.generate_assignments(game.id)


# --- missions --------------------------------------------------------------


def test_every_player_gets_a_mission_that_is_not_their_own_word(engine):
    game, players = seed_lobby(engine, 8)
    engine.generate_assignments(game.id)
    for p in players:
        mission = engine.get_mission(p.id)
        own = engine.storage.get_player(p.id).word
        assert mission is not None
        assert mission.target_id != p.id
        assert mission.word.lower() != own.lower()


def test_no_engine_method_exposes_the_whole_map(engine):
    """Secrecy: there is no 'show me everything' call on the public surface."""
    game, _ = seed_lobby(engine, 4)
    engine.generate_assignments(game.id)
    status = engine.current_status(game.id)
    rendered = repr(status)
    for player in engine.storage.players(game.id):
        assert player.word not in rendered
        assert player.mission_word not in rendered


# --- reporting -------------------------------------------------------------


def _hunter_and_mission(engine, game_id):
    hunter = engine.storage.alive_players(game_id)[0]
    return hunter, engine.get_mission(hunter.id)


def test_can_only_report_your_own_target(engine):
    game, players = seed_lobby(engine, 5)
    engine.generate_assignments(game.id)
    hunter, mission = _hunter_and_mission(engine, game.id)
    wrong = next(
        p for p in engine.storage.players(game.id) if p.id not in (hunter.id, mission.target_id)
    )
    with pytest.raises(RuleViolation, match="not your target"):
        engine.report_gotcha(game.id, hunter.id, wrong.display_name)
    report = engine.report_gotcha(game.id, hunter.id, mission.target_name)
    assert report.state == PENDING


def test_duplicate_report_is_idempotent(engine):
    game, players = seed_lobby(engine, 5)
    engine.generate_assignments(game.id)
    hunter, mission = _hunter_and_mission(engine, game.id)
    a = engine.report_gotcha(game.id, hunter.id, mission.target_name)
    b = engine.report_gotcha(game.id, hunter.id, mission.target_name)
    assert a.id == b.id
    assert len(engine.pending_reports(game.id)) == 1


def test_reporter_cannot_confirm_their_own_gotcha(engine):
    game, players = seed_lobby(engine, 5)
    engine.generate_assignments(game.id)
    hunter, mission = _hunter_and_mission(engine, game.id)
    report = engine.report_gotcha(game.id, hunter.id, mission.target_name)
    with pytest.raises(RuleViolation, match="cannot confirm your own"):
        engine.confirm_gotcha(game.id, report.id, hunter.id)
    assert report not in engine.confirmable_reports(game.id, hunter.id)


def test_victim_may_confirm_their_own_death(engine):
    game, players = seed_lobby(engine, 5)
    engine.generate_assignments(game.id)
    hunter, mission = _hunter_and_mission(engine, game.id)
    report = engine.report_gotcha(game.id, hunter.id, mission.target_name)
    result = engine.confirm_gotcha(game.id, report.id, mission.target_id)
    assert result.victim_id == mission.target_id
    assert engine.current_status(game.id).alive_count == 4


def test_eliminated_player_may_confirm_later_gotchas(engine):
    game, players = seed_lobby(engine, 6)
    engine.generate_assignments(game.id)
    hunter, mission = _hunter_and_mission(engine, game.id)
    first = engine.report_gotcha(game.id, hunter.id, mission.target_name)
    dead_id = mission.target_id
    engine.confirm_gotcha(game.id, first.id, dead_id)

    # The hunter continues with the inherited mission; the dead player witnesses.
    next_mission = engine.get_mission(hunter.id)
    second = engine.report_gotcha(game.id, hunter.id, next_mission.target_name)
    result = engine.confirm_gotcha(game.id, second.id, dead_id)
    assert result.victim_name == next_mission.target_name
    assert engine.current_status(game.id).alive_count == 4


def test_eliminated_player_cannot_report(engine):
    game, players = seed_lobby(engine, 5)
    engine.generate_assignments(game.id)
    hunter, mission = _hunter_and_mission(engine, game.id)
    victim_id = mission.target_id
    victim_mission = engine.get_mission(victim_id)
    report = engine.report_gotcha(game.id, hunter.id, mission.target_name)
    engine.confirm_gotcha(game.id, report.id, victim_id)
    with pytest.raises(RuleViolation, match="out of the game"):
        engine.report_gotcha(game.id, victim_id, victim_mission.target_name)


def test_reporter_can_withdraw_own_claim(engine):
    game, players = seed_lobby(engine, 5)
    engine.generate_assignments(game.id)
    hunter, mission = _hunter_and_mission(engine, game.id)
    report = engine.report_gotcha(game.id, hunter.id, mission.target_name)
    other = next(p for p in engine.storage.players(game.id) if p.id != hunter.id)
    with pytest.raises(RuleViolation, match="Only the person who claimed"):
        engine.cancel_gotcha(game.id, report.id, other.id)
    engine.cancel_gotcha(game.id, report.id, hunter.id)
    assert engine.pending_reports(game.id) == []
    with pytest.raises(RuleViolation, match="withdrawn"):
        engine.confirm_gotcha(game.id, report.id, other.id)


# --- inheritance ----------------------------------------------------------


def test_hunter_inherits_victims_target_and_word(engine):
    game, players = seed_lobby(engine, 6)
    engine.generate_assignments(game.id)
    hunter, mission = _hunter_and_mission(engine, game.id)
    victim_mission = engine.get_mission(mission.target_id)  # what the victim held

    report = engine.report_gotcha(game.id, hunter.id, mission.target_name)
    witness = next(p for p in engine.storage.players(game.id) if p.id != hunter.id)
    result = engine.confirm_gotcha(game.id, report.id, witness.id)

    inherited = engine.get_mission(hunter.id)
    assert inherited.target_id == victim_mission.target_id
    assert inherited.word == victim_mission.word
    assert result.new_mission.target_name == victim_mission.target_name
    # The dead player keeps nothing.
    assert engine.get_mission(mission.target_id) is None
    assert result.announcement.startswith("💀")
    assert "(5 left)" in result.announcement


def test_double_confirm_never_double_eliminates(engine):
    game, players = seed_lobby(engine, 6)
    engine.generate_assignments(game.id)
    hunter, mission = _hunter_and_mission(engine, game.id)
    report = engine.report_gotcha(game.id, hunter.id, mission.target_name)
    witnesses = [p for p in engine.storage.players(game.id) if p.id != hunter.id]

    first = engine.confirm_gotcha(game.id, report.id, witnesses[0].id)
    assert not first.already_confirmed
    second = engine.confirm_gotcha(game.id, report.id, witnesses[1].id)
    assert second.already_confirmed
    assert engine.current_status(game.id).alive_count == 5
    assert engine.storage.get_report(report.id).state == CONFIRMED


def test_stale_claim_is_rejected_after_inheritance(engine):
    """A claim whose hunter has since moved on is void, not a free kill."""
    game, players = seed_lobby(engine, 6)
    engine.generate_assignments(game.id)
    hunter, mission = _hunter_and_mission(engine, game.id)
    report = engine.report_gotcha(game.id, hunter.id, mission.target_name)
    witness = next(p for p in engine.storage.players(game.id) if p.id != hunter.id)
    engine.confirm_gotcha(game.id, report.id, witness.id)

    # Forge the situation: re-open the confirmed claim as if it were pending.
    engine.storage.set_report_state(report.id, PENDING)
    with pytest.raises(RuleViolation, match="already out"):
        engine.confirm_gotcha(game.id, report.id, witness.id)


# --- endgame --------------------------------------------------------------


def test_two_players_left_produces_exactly_one_winner(engine):
    game, players = seed_lobby(engine, 2)
    engine.generate_assignments(game.id)
    a, b = engine.storage.players(game.id)
    mission = engine.get_mission(a.id)
    assert mission.target_id == b.id  # a 2-cycle is the only option

    report = engine.report_gotcha(game.id, a.id, mission.target_name)
    result = engine.confirm_gotcha(game.id, report.id, b.id)

    assert result.game_over
    assert result.winner_id == a.id
    assert result.new_mission is None
    assert "🏆" in result.announcement
    status = engine.current_status(game.id)
    assert status.game.is_finished
    assert status.alive_count == 1
    assert status.winner_name == a.display_name
    assert engine.winner(game.id).id == a.id
    # Nothing more can happen in a finished game.
    with pytest.raises(RuleViolation, match="already over"):
        engine.report_gotcha(game.id, a.id, b.display_name)
    assert engine.get_mission(a.id) is None


def test_winner_is_announced_in_the_public_feed(engine):
    game, players = seed_lobby(engine, 3)
    engine.generate_assignments(game.id)
    while not engine.current_status(game.id).game.is_finished:
        hunter = engine.storage.alive_players(game.id)[0]
        mission = engine.get_mission(hunter.id)
        report = engine.report_gotcha(game.id, hunter.id, mission.target_name)
        witness = next(p for p in engine.storage.players(game.id) if p.id != hunter.id)
        engine.confirm_gotcha(game.id, report.id, witness.id)
    feed = [item.message for item in engine.current_status(game.id).feed]
    assert any("🏆" in m for m in feed)
    assert sum(1 for m in feed if m.startswith("💀")) == 2
    # The feed never mentions a word.
    words = {p.word for p in engine.storage.players(game.id)}
    assert not any(w in m for m in feed for w in words)


def test_broken_chain_is_caught_before_delivery(engine, monkeypatch):
    """If the generator ever produced two loops, generation must abort."""
    game, players = seed_lobby(engine, 4)
    ids = [p.id for p in players]
    two_loops = {ids[0]: ids[1], ids[1]: ids[0], ids[2]: ids[3], ids[3]: ids[2]}
    monkeypatch.setattr("gotcha.engine.build_target_cycle", lambda *a, **k: two_loops)
    with pytest.raises(AssignmentError, match="single cycle"):
        engine.generate_assignments(game.id)
    # Nothing was written, nothing was announced.
    assert all(p.target_id is None for p in engine.storage.players(game.id))
    assert engine.current_status(game.id).game.is_lobby
