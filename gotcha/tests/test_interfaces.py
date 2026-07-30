"""Smoke tests for the two interfaces: they must wire up and leak nothing.

The rules themselves are tested in test_engine.py / test_full_game.py - these
tests only check the shells around the engine.
"""

import pytest
from conftest import seed_lobby
from fastapi.testclient import TestClient

from gotcha.telegram_bot import build_application, parse_admin_ids
from gotcha.webapp import create_app


# --- Telegram ------------------------------------------------------------


def test_bot_application_builds_with_all_commands(engine):
    app = build_application("123456:fake-token-for-tests", engine, admin_ids={7})
    registered = set()
    for group in app.handlers.values():
        for handler in group:
            registered |= set(getattr(handler, "commands", set()) or set())
    for command in ["join", "word", "mission", "gotcha", "confirm", "status", "begin", "kick", "lobby"]:
        assert command in registered, f"/{command} is not wired up"
    assert app.bot_data["engine"] is engine
    assert app.bot_data["admin_ids"] == {7}


def test_parse_admin_ids():
    assert parse_admin_ids("") == set()
    assert parse_admin_ids("111, 222") == {111, 222}


def test_the_admin_lobby_view_contains_no_secret(engine):
    """/lobby is built from current_status only, so it cannot leak a word."""
    game, players = seed_lobby(engine, 6)
    engine.generate_assignments(game.id)
    status = engine.current_status(game.id)
    rendered = " ".join(
        [status.game.name]
        + [p.name for p in status.players]
        + [i.message for i in status.feed]
    )
    for p in engine.storage.players(game.id):
        assert p.word not in rendered
        assert p.mission_word not in rendered


def test_engine_has_no_method_that_returns_the_whole_map(engine):
    """Secrecy by construction: only generation ever hands over every mission.

    If somebody later adds a `get_all_missions()` helper, this test fails and
    forces the question "who is that for?".
    """
    public_api = [
        name
        for name in dir(engine)
        if not name.startswith("_") and callable(getattr(engine, name))
    ]
    assert sorted(public_api) == sorted(
        [
            "add_player",
            "cancel_gotcha",
            "confirm_gotcha",
            "confirmable_reports",
            "create_game",
            "current_game",
            "current_status",
            "find_player_by_name",
            "generate_assignments",
            "get_mission",
            "get_or_create_game",
            "pending_reports",
            "remove_player",
            "report_gotcha",
            "set_name",
            "submit_word",
            "winner",
        ]
    ), "the engine's public surface changed - does the new call leak assignments?"


# --- Web ----------------------------------------------------------------


@pytest.fixture()
def web(engine):
    app = create_app(engine=engine, admin_key="testkey")
    return TestClient(app)


def test_public_feed_never_shows_words(web, engine):
    game, players = seed_lobby(engine, 4)
    engine.generate_assignments(game.id)
    body = web.get("/").text
    for p in engine.storage.players(game.id):
        assert p.word not in body
        assert p.mission_word not in body
    assert "P00" in body  # names are public


def test_admin_page_requires_key_and_shows_no_secrets(web, engine):
    game, players = seed_lobby(engine, 4)
    engine.generate_assignments(game.id)
    assert "admin key" in web.get("/admin").text.lower()
    body = web.get("/admin", params={"key": "testkey"}).text
    for p in engine.storage.players(game.id):
        assert p.word not in body
        assert p.mission_word not in body
        assert p.token not in body  # no magic links leak after the lobby
    assert "cannot show you who hunts whom" in body


def test_player_page_shows_only_that_players_mission(web, engine):
    game, players = seed_lobby(engine, 5)
    engine.generate_assignments(game.id)
    me = engine.storage.get_player(players[0].id)
    mission = engine.get_mission(me.id)

    body = web.get(f"/p/{me.token}").text
    assert mission.target_name in body
    assert mission.word in body
    # Nobody else's word appears on my page.
    for other in engine.storage.players(game.id):
        if other.id == me.id:
            continue
        if other.mission_word and other.mission_word.lower() != mission.word.lower():
            assert other.mission_word not in body


def test_unknown_token_is_a_dead_end(web):
    assert "Unknown link" in web.get("/p/not-a-real-token").text


def test_full_game_playable_through_the_web(web, engine):
    """Join -> word -> start -> gotcha -> confirm -> winner, all over HTTP."""
    game = engine.create_game("Web game")
    tokens = []
    for i in range(4):
        player = engine.add_player(game.id, name=None)
        tokens.append(player.token)
        response = web.post(
            f"/p/{player.token}/setup",
            data={"name": f"Web{i}", "word": f"word{i}"},
            follow_redirects=True,
        )
        assert response.status_code == 200

    assert engine.current_status(game.id).ready_count == 4
    web.post("/admin/begin", data={"key": "testkey"}, follow_redirects=True)
    assert engine.current_status(game.id).game.is_active

    guard = 0
    while not engine.current_status(game.id).game.is_finished:
        guard += 1
        assert guard < 20
        hunter = engine.storage.alive_players(game.id)[0]
        mission = engine.get_mission(hunter.id)
        hunter_token = engine.storage.get_player(hunter.id).token
        web.post(
            f"/p/{hunter_token}/gotcha",
            data={"target_name": mission.target_name},
            follow_redirects=True,
        )
        report = engine.pending_reports(game.id)[0]
        witness = next(p for p in engine.storage.players(game.id) if p.id != hunter.id)
        web.post(
            f"/p/{witness.token}/confirm",
            data={"report_id": report.id},
            follow_redirects=True,
        )

    status = engine.current_status(game.id)
    assert status.alive_count == 1
    assert status.winner_name
    assert "won" in web.get("/").text


def test_web_rejects_gotcha_on_a_non_target(web, engine):
    game, players = seed_lobby(engine, 5)
    engine.generate_assignments(game.id)
    me = engine.storage.get_player(players[0].id)
    mission = engine.get_mission(me.id)
    wrong = next(p for p in engine.storage.players(game.id) if p.id not in (me.id, mission.target_id))
    body = web.post(
        f"/p/{me.token}/gotcha", data={"target_name": wrong.display_name}, follow_redirects=True
    ).text
    assert "not your target" in body
    assert engine.pending_reports(game.id) == []


def test_admin_invite_creates_a_magic_link(web, engine):
    engine.create_game("Invites")
    body = web.post("/admin/invite", data={"key": "testkey"}, follow_redirects=True).text
    assert "/p/" in body
    assert len(engine.storage.players(engine.current_game().id)) == 1


def test_wrong_admin_key_cannot_start_the_game(web, engine):
    game, players = seed_lobby(engine, 4)
    web.post("/admin/begin", data={"key": "wrong"}, follow_redirects=True)
    assert engine.current_status(game.id).game.is_lobby
