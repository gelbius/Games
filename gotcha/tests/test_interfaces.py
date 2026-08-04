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


# --- running the web app on its own (no Telegram anywhere) -----------------


def test_admin_can_mint_a_batch_of_invite_links(web, engine):
    engine.create_game("Standalone")
    body = web.post(
        "/admin/invite", data={"key": "testkey", "count": "16"}, follow_redirects=True
    ).text
    game_id = engine.current_game().id
    assert len(engine.storage.players(game_id)) == 16
    assert "16 unclaimed invite link(s)" in body
    # Every link is on the page, ready to be handed out.
    for player in engine.storage.players(game_id):
        assert f"/p/{player.token}" in body


def test_a_claimed_link_disappears_from_the_admin_page_forever(web, engine):
    """The admin hands links out once; after that a link is somebody's identity."""
    engine.create_game("Standalone")
    web.post("/admin/invite", data={"key": "testkey", "count": "3"}, follow_redirects=True)
    game_id = engine.current_game().id
    first, second, third = engine.storage.players(game_id)

    web.post(
        f"/p/{first.token}/setup", data={"name": "Ana", "word": "pineapple"}, follow_redirects=True
    )
    body = web.get("/admin", params={"key": "testkey"}).text
    assert first.token not in body, "a signed-in player's magic link must never be shown again"
    assert second.token in body and third.token in body
    assert "2 unclaimed invite link(s)" in body
    assert "Ana" in body  # they appear as a player instead


def test_invite_count_is_validated(web, engine):
    engine.create_game("Standalone")
    assert "Give me a number" in web.post(
        "/admin/invite", data={"key": "testkey", "count": "lots"}, follow_redirects=True
    ).text
    assert "Between 1 and 100" in web.post(
        "/admin/invite", data={"key": "testkey", "count": "500"}, follow_redirects=True
    ).text
    assert engine.storage.players(engine.current_game().id) == []


def test_unclaimed_invites_are_not_shown_as_players(web, engine):
    engine.create_game("Standalone")
    web.post("/admin/invite", data={"key": "testkey", "count": "4"}, follow_redirects=True)
    game_id = engine.current_game().id
    first = engine.storage.players(game_id)[0]
    web.post(f"/p/{first.token}/setup", data={"name": "Ana", "word": "pineapple"}, follow_redirects=True)

    feed = web.get("/").text
    assert "Ana" in feed
    assert "Player #" not in feed, "an unopened invite is not a person"
    assert engine.current_status(game_id).joined_count == 1


def test_links_are_built_from_the_tunnel_address(web, engine, monkeypatch):
    """Behind Cloudflare Tunnel the links must be the public URL, not localhost."""
    monkeypatch.delenv("GOTCHA_WEB_BASE", raising=False)
    engine.create_game("Standalone")
    web.post("/admin/invite", data={"key": "testkey", "count": "1"}, follow_redirects=True)
    body = web.get(
        "/admin",
        params={"key": "testkey"},
        headers={"x-forwarded-host": "gotcha-weekend.trycloudflare.com", "x-forwarded-proto": "https"},
    ).text
    assert "https://gotcha-weekend.trycloudflare.com/p/" in body
    assert "localhost" not in body

    # An explicit setting still wins over the headers.
    monkeypatch.setenv("GOTCHA_WEB_BASE", "https://gotcha.example.com")
    body = web.get("/admin", params={"key": "testkey"}).text
    assert "https://gotcha.example.com/p/" in body


def test_a_whole_standalone_game_with_no_telegram_at_all(web, engine):
    """16 invites -> everyone signs in -> start -> play to a single winner."""
    engine.create_game("Lake house")
    web.post("/admin/invite", data={"key": "testkey", "count": "16"}, follow_redirects=True)
    game_id = engine.current_game().id
    tokens = [p.token for p in engine.storage.players(game_id)]
    assert all(p.telegram_id is None for p in engine.storage.players(game_id))

    for i, token in enumerate(tokens):
        web.post(
            f"/p/{token}/setup",
            data={"name": f"Guest{i:02d}", "word": f"word{i:02d}"},
            follow_redirects=True,
        )
    assert engine.current_status(game_id).ready_count == 16

    web.post("/admin/begin", data={"key": "testkey"}, follow_redirects=True)
    assert engine.current_status(game_id).game.is_active

    guard = 0
    while not engine.current_status(game_id).game.is_finished:
        guard += 1
        assert guard < 40
        hunter = engine.storage.alive_players(game_id)[0]
        mission = engine.get_mission(hunter.id)
        hunter_token = engine.storage.get_player(hunter.id).token
        web.post(
            f"/p/{hunter_token}/gotcha",
            data={"target_name": mission.target_name},
            follow_redirects=True,
        )
        report = engine.pending_reports(game_id)[0]
        witness = next(p for p in engine.storage.players(game_id) if p.id != hunter.id)
        web.post(
            f"/p/{witness.token}/confirm", data={"report_id": report.id}, follow_redirects=True
        )

    status = engine.current_status(game_id)
    assert status.alive_count == 1 and status.eliminated_count == 15
    assert status.winner_name
    # And the admin page still cannot show a single assignment.
    admin = web.get("/admin", params={"key": "testkey"}).text
    for player in engine.storage.players(game_id):
        assert (player.word or "x") not in admin
        assert player.token not in admin


def test_admin_can_start_a_fresh_game_after_one_finishes(web, engine):
    """A finished game is a dead end without this - nothing else can restart it."""
    game, players = seed_lobby(engine, 2)
    engine.generate_assignments(game.id)
    hunter = engine.storage.alive_players(game.id)[0]
    mission = engine.get_mission(hunter.id)
    report = engine.report_gotcha(game.id, hunter.id, mission.target_name)
    engine.confirm_gotcha(game.id, report.id, mission.target_id)
    assert engine.current_status(game.id).game.is_finished

    body = web.get("/admin", params={"key": "testkey"}).text
    assert "Start a fresh game" in body and "That game is over" in body

    body = web.post(
        "/admin/newgame", data={"key": "testkey", "name": "Round 2"}, follow_redirects=True
    ).text
    assert "Round 2" in body
    fresh = engine.current_game()
    assert fresh.id != game.id and fresh.is_lobby
    assert engine.storage.players(fresh.id) == []

    # And the new game is playable: invites work again.
    web.post("/admin/invite", data={"key": "testkey", "count": "2"}, follow_redirects=True)
    assert len(engine.storage.players(engine.current_game().id)) == 2


def test_starting_a_fresh_game_needs_the_admin_key(web, engine):
    game, players = seed_lobby(engine, 3)
    web.post("/admin/newgame", data={"key": "nope", "name": "Hijack"}, follow_redirects=True)
    assert engine.current_game().id == game.id


def test_admin_warns_before_abandoning_a_running_game(web, engine):
    game, players = seed_lobby(engine, 4)
    engine.generate_assignments(game.id)
    body = web.get("/admin", params={"key": "testkey"}).text
    assert "A game is in progress" in body and "abandons it" in body
