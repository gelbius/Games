"""Web interface (interface #2). Same engine, same database, same rules.

Three kinds of page:

  /              public feed - eliminations and how many are left
  /p/<token>     ONE player's private page (their "magic link"): submit a word,
                 read their mission, claim a gotcha, confirm someone else's
  /admin?key=..  admin status: join progress and the start button.
                 Deliberately incapable of showing assignments.

The magic link *is* the login: whoever holds the link is that player. So links
are sent privately and never shown on the admin page after the game starts (the
admin hands them out once and cannot see anyone's mission through them anyway -
opening someone's page would be exactly as much cheating as reading their DMs).
"""

from __future__ import annotations

import html
import os
import secrets
from typing import List, Optional
from urllib.parse import urlencode

from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from .engine import GotchaEngine, GotchaError
from .models import Report, Status
from .storage import Storage

CSS = """
:root { color-scheme: light dark; --fg:#1b1b1f; --bg:#fbfaf7; --muted:#6b6b76;
        --card:#ffffff; --line:#e6e3dc; --accent:#b3261e; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#ece9e4; --bg:#16161a; --muted:#9a97a1; --card:#1f1f25;
          --line:#31313a; --accent:#ff6b5e; }
}
* { box-sizing: border-box; }
body { margin:0; padding:2rem 1rem; background:var(--bg); color:var(--fg);
       font:16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 34rem; margin: 0 auto; }
h1 { font-size:1.6rem; margin:0 0 .2rem; letter-spacing:-.01em; }
h2 { font-size:1.05rem; margin:1.6rem 0 .5rem; text-transform:uppercase;
     letter-spacing:.08em; color:var(--muted); }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px;
        padding:1rem 1.1rem; margin:.8rem 0; }
.mission { text-align:center; padding:1.4rem 1rem; }
.mission .label { font-size:.75rem; text-transform:uppercase; letter-spacing:.1em; color:var(--muted); }
.mission .value { font-size:1.7rem; font-weight:650; margin:.1rem 0 .9rem; }
.muted { color:var(--muted); font-size:.9rem; }
ul { list-style:none; padding:0; margin:0; }
li { padding:.35rem 0; border-bottom:1px solid var(--line); }
li:last-child { border-bottom:none; }
form { margin:.6rem 0 0; }
input[type=text], select { width:100%; padding:.6rem .7rem; font-size:1rem;
        border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); }
button { margin-top:.6rem; padding:.6rem 1rem; font-size:1rem; font-weight:600;
         border:0; border-radius:8px; background:var(--accent); color:#fff; cursor:pointer; }
button.ghost { background:transparent; color:var(--muted); border:1px solid var(--line); }
.err { border-color:var(--accent); }
.err strong { color:var(--accent); }
.dead { color:var(--muted); text-decoration:line-through; }
footer { margin-top:2rem; font-size:.8rem; color:var(--muted); text-align:center; }
"""


def esc(value) -> str:
    return html.escape(str(value if value is not None else ""))


def page(title: str, body: str, refresh: Optional[int] = None) -> HTMLResponse:
    meta = f'<meta http-equiv="refresh" content="{refresh}">' if refresh else ""
    doc = (
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<meta name='referrer' content='no-referrer'>"
        f"{meta}<title>{esc(title)}</title><style>{CSS}</style></head>"
        f"<body><main>{body}</main></body></html>"
    )
    response = HTMLResponse(doc)
    # Magic links are secrets: never let a proxy or the browser cache a page.
    response.headers["Cache-Control"] = "no-store, private"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


def _feed_html(status: Status, limit: int = 25) -> str:
    items = [i for i in status.feed if i.kind in ("elimination", "winner", "started", "joined")][:limit]
    if not items:
        return "<p class='muted'>Nothing has happened yet.</p>"
    return "<ul>" + "".join(f"<li>{esc(i.message)}</li>" for i in items) + "</ul>"


def _players_html(status: Status) -> str:
    """The roster. Invite links nobody has opened yet are not people, so they
    are left out rather than shown as a row of ghostly 'Player #7's."""
    rows = []
    for p in [p for p in status.players if p.claimed]:
        if status.game.is_lobby:
            rows.append(f"<li>{'✅' if p.ready else '⏳'} {esc(p.name)}</li>")
        else:
            cls = "" if p.alive else " class='dead'"
            rows.append(f"<li{cls}>{'🙂' if p.alive else '💀'} {esc(p.name)}</li>")
    if not rows:
        return "<p class='muted'>Nobody has signed in yet.</p>"
    return "<ul>" + "".join(rows) + "</ul>"


def _confirm_html(reports: List[Report], token: str) -> str:
    if not reports:
        return ""
    blocks = [
        "<h2>Waiting for a witness</h2>",
        "<p class='muted'>Only confirm what you believe actually happened.</p>",
    ]
    for r in reports:
        blocks.append(
            f"<div class='card'>{esc(r.reporter_name)} got <strong>{esc(r.target_name)}</strong> "
            f"to say “{esc(r.word)}”."
            f"<form method='post' action='/p/{esc(token)}/confirm'>"
            f"<input type='hidden' name='report_id' value='{r.id}'>"
            "<button>✅ Confirm this gotcha</button></form></div>"
        )
    return "".join(blocks)


def public_base(request: Request) -> str:
    """The address to build magic links from.

    GOTCHA_WEB_BASE wins if set. Otherwise we trust the forwarding headers that
    Cloudflare Tunnel / ngrok add, so opening the admin page *through* the tunnel
    hands out tunnel links rather than useless http://localhost:8000 ones.
    """
    configured = os.environ.get("GOTCHA_WEB_BASE", "").strip().rstrip("/")
    if configured:
        return configured
    host = request.headers.get("x-forwarded-host") or request.headers.get("host")
    if host:
        proto = request.headers.get("x-forwarded-proto", request.url.scheme)
        return f"{proto}://{host}"
    return str(request.base_url).rstrip("/")


def create_app(engine: Optional[GotchaEngine] = None, admin_key: Optional[str] = None) -> FastAPI:
    engine = engine or GotchaEngine(Storage(os.environ.get("GOTCHA_DB", "gotcha.db")))
    admin_key = admin_key or os.environ.get("GOTCHA_ADMIN_KEY") or secrets.token_urlsafe(12)

    app = FastAPI(title="Gotcha", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.engine = engine
    app.state.admin_key = admin_key

    def game_id() -> int:
        return engine.get_or_create_game(os.environ.get("GOTCHA_GAME_NAME", "Gotcha")).id

    def player_or_404(token: str):
        player = engine.storage.player_by_token(token)
        if not player:
            raise LookupError
        return player

    # ---------------- public feed ----------------

    @app.get("/", response_class=HTMLResponse)
    def public_feed():
        status = engine.current_status(game_id())
        header = f"<h1>{esc(status.game.name)}</h1>"
        if status.game.is_lobby:
            sub = f"<p class='muted'>Waiting to start - {status.ready_count}/{status.joined_count} players ready.</p>"
        elif status.winner_name:
            sub = f"<p class='muted'>🏆 <strong>{esc(status.winner_name)}</strong> won.</p>"
        else:
            sub = f"<p class='muted'><strong>{status.alive_count}</strong> still alive, {status.eliminated_count} out.</p>"
        return page(
            status.game.name,
            header + sub
            + "<h2>Players</h2>" + _players_html(status)
            + "<h2>Feed</h2>" + _feed_html(status)
            + "<footer>No assignments are shown on this page, ever.</footer>",
            refresh=20,
        )

    # ---------------- one player's private page ----------------

    @app.get("/p/{token}", response_class=HTMLResponse)
    def player_page(token: str, msg: str = "", err: str = ""):
        try:
            player = player_or_404(token)
        except LookupError:
            return page("Unknown link", "<h1>Unknown link</h1><p>Ask the organiser for your link again.</p>")

        status = engine.current_status(player.game_id)
        parts = [f"<h1>{esc(status.game.name)}</h1>"]
        if err:
            parts.append(f"<div class='card err'><strong>{esc(err)}</strong></div>")
        elif msg:
            parts.append(f"<div class='card'>{esc(msg)}</div>")

        # --- lobby: name + word form ---
        if status.game.is_lobby:
            parts.append(
                "<div class='card'><p>Pick the name people know you by, and one word you "
                "want other players tricked into saying.</p>"
                f"<form method='post' action='/p/{esc(token)}/setup'>"
                f"<label class='muted'>Your name</label>"
                f"<input type='text' name='name' value='{esc(player.name or '')}' maxlength='40' required>"
                "<label class='muted'>Your secret word</label>"
                f"<input type='text' name='word' value='{esc(player.word or '')}' maxlength='40' required>"
                "<button>Save</button></form>"
                "<p class='muted'>You can change both until the game starts. Nobody else - "
                "including the organiser - can see your word.</p></div>"
            )
            parts.append(f"<h2>Lobby ({status.ready_count}/{status.joined_count} ready)</h2>")
            parts.append(_players_html(status))
            return page("Your Gotcha page", "".join(parts))

        # --- in play: the mission ---
        mission = engine.get_mission(player.id)
        if status.winner_name:
            crown = "🏆 You won!" if status.winner_name == player.display_name else f"🏆 {esc(status.winner_name)} won."
            parts.append(f"<div class='card mission'><div class='value'>{crown}</div></div>")
        elif mission:
            parts.append(
                "<div class='card mission'>"
                "<div class='label'>Your target</div>"
                f"<div class='value'>{esc(mission.target_name)}</div>"
                "<div class='label'>Must say the word</div>"
                f"<div class='value'>{esc(mission.word)}</div>"
                "<div class='muted'>Keep this to yourself.</div></div>"
            )
            mine = [r for r in engine.pending_reports(player.game_id) if r.reporter_id == player.id]
            if mine:
                parts.append(
                    "<div class='card'>⏳ Your claim is waiting for another player to confirm."
                    f"<form method='post' action='/p/{esc(token)}/withdraw'>"
                    "<button class='ghost'>Withdraw it</button></form></div>"
                )
            else:
                parts.append(
                    f"<div class='card'><form method='post' action='/p/{esc(token)}/gotcha'>"
                    "<label class='muted'>Got them to say it?</label>"
                    f"<input type='hidden' name='target_name' value='{esc(mission.target_name)}'>"
                    f"<button>🎉 Gotcha, {esc(mission.target_name)}!</button></form></div>"
                )
        elif not player.alive:
            parts.append(
                "<div class='card mission'><div class='value'>💀 You are out</div>"
                "<div class='muted'>You can still confirm other people's gotchas.</div></div>"
            )

        parts.append(_confirm_html(engine.confirmable_reports(player.game_id, player.id), token))
        parts.append(f"<h2>{status.alive_count} still alive</h2>")
        parts.append(_players_html(status))
        parts.append("<h2>Feed</h2>" + _feed_html(status, limit=10))
        # Web players get no push notifications, so once the game is running the
        # page refreshes itself: a claim to witness, or a mission you inherited,
        # appears without anyone needing to know to reload. Not during the lobby,
        # where a refresh would wipe what they are typing.
        return page("Your Gotcha page", "".join(parts), refresh=30)

    def back(token: str, msg: str = "", err: str = "") -> RedirectResponse:
        """POST -> redirect -> GET, carrying a one-line result message."""
        query = urlencode({k: v for k, v in (("msg", msg), ("err", err)) if v})
        return RedirectResponse(f"/p/{token}" + (f"?{query}" if query else ""), status_code=303)

    @app.post("/p/{token}/setup")
    def submit_setup(token: str, name: str = Form(...), word: str = Form(...)):
        try:
            player = player_or_404(token)
            engine.set_name(player.id, name)
            engine.submit_word(player.id, word)
        except LookupError:
            return RedirectResponse("/", status_code=303)
        except GotchaError as exc:
            return back(token, err=str(exc))
        return back(token, msg="Saved. Your word is secret - sit tight until the game starts.")

    @app.post("/p/{token}/gotcha")
    def submit_gotcha(token: str, target_name: str = Form(...)):
        try:
            player = player_or_404(token)
            engine.report_gotcha(player.game_id, player.id, target_name)
        except LookupError:
            return RedirectResponse("/", status_code=303)
        except GotchaError as exc:
            return back(token, err=str(exc))
        return back(token, msg="Claim filed - now another player has to confirm it.")

    @app.post("/p/{token}/withdraw")
    def submit_withdraw(token: str):
        try:
            player = player_or_404(token)
            for report in engine.pending_reports(player.game_id):
                if report.reporter_id == player.id:
                    engine.cancel_gotcha(player.game_id, report.id, player.id)
        except LookupError:
            return RedirectResponse("/", status_code=303)
        except GotchaError as exc:
            return back(token, err=str(exc))
        return back(token, msg="Withdrawn.")

    @app.post("/p/{token}/confirm")
    def submit_confirm(token: str, report_id: int = Form(...)):
        try:
            player = player_or_404(token)
            result = engine.confirm_gotcha(player.game_id, report_id, player.id)
        except LookupError:
            return RedirectResponse("/", status_code=303)
        except GotchaError as exc:
            return back(token, err=str(exc))
        if result.already_confirmed:
            return back(token, msg="Already confirmed by somebody else.")
        note = result.announcement.splitlines()[0]
        if result.game_over:
            note += f" {result.winner_name} wins!"
        return back(token, msg=note)

    # ---------------- admin ----------------

    def admin_ok(key: str) -> bool:
        return secrets.compare_digest(key or "", app.state.admin_key)

    @app.get("/admin", response_class=HTMLResponse)
    def admin_page(request: Request, key: str = "", msg: str = "", err: str = ""):
        if not admin_ok(key):
            return page("Admin", "<h1>Admin</h1><p>Add your admin key to the URL: <code>/admin?key=...</code></p>")
        status = engine.current_status(game_id())
        k = esc(key)
        parts = [f"<h1>Admin - {esc(status.game.name)}</h1>"]
        if err:
            parts.append(f"<div class='card err'><strong>{esc(err)}</strong></div>")
        elif msg:
            parts.append(f"<div class='card'>{esc(msg)}</div>")
        # Unclaimed invite links are safe to show: they belong to nobody yet and
        # carry no mission. The moment somebody signs in with one it disappears
        # from this page forever - that link is their identity from then on.
        base = public_base(request)
        unclaimed = [p for p in engine.storage.players(game_id()) if not p.name]
        if unclaimed:
            listed = "<br>".join(f"<code>{esc(base)}/p/{esc(p.token)}</code>" for p in unclaimed)
            parts.append(
                f"<div class='card'><strong>{len(unclaimed)} unclaimed invite link(s)</strong>"
                f"<p class='muted'>Send one to each person, privately - one link per human. "
                "They vanish from here as soon as someone signs in with them.</p>"
                f"{listed}</div>"
            )
        parts.append(
            f"<div class='card'>State: <strong>{esc(status.game.state)}</strong><br>"
            f"Joined: {status.joined_count} &middot; ready: {status.ready_count} &middot; "
            f"alive: {status.alive_count} &middot; out: {status.eliminated_count}"
            + (f"<br>🏆 Winner: <strong>{esc(status.winner_name)}</strong>" if status.winner_name else "")
            + "</div>"
        )
        parts.append("<h2>Players</h2>" + _players_html(status))
        if status.game.is_lobby:
            parts.append(
                f"<div class='card'><form method='post' action='/admin/invite'>"
                f"<input type='hidden' name='key' value='{k}'>"
                "<label class='muted'>How many invite links do you need?</label>"
                "<input type='text' name='count' value='16' inputmode='numeric'>"
                "<button class='ghost'>➕ Create invite links</button></form>"
                f"<form method='post' action='/admin/kick'>"
                f"<input type='hidden' name='key' value='{k}'>"
                "<label class='muted'>Remove a no-show</label>"
                "<input type='text' name='name' placeholder='name'>"
                "<button class='ghost'>Remove</button></form>"
                f"<form method='post' action='/admin/begin'>"
                f"<input type='hidden' name='key' value='{k}'>"
                "<button>🎯 Generate &amp; send missions</button></form></div>"
            )
        elif status.game.is_active:
            parts.append(
                f"<div class='card'><form method='post' action='/admin/begin'>"
                f"<input type='hidden' name='key' value='{k}'>"
                "<button class='ghost'>🔄 Re-roll (only before the first elimination)</button>"
                "</form></div>"
            )
        parts.append("<h2>Feed</h2>" + _feed_html(status))
        parts.append(
            "<footer>This page cannot show you who hunts whom or who holds which word. "
            "No page can - the engine has no such call.</footer>"
        )
        return page("Gotcha admin", "".join(parts), refresh=None)

    def admin_back(key: str, msg: str = "", err: str = "") -> RedirectResponse:
        return RedirectResponse(
            "/admin?" + urlencode({k: v for k, v in {"key": key, "msg": msg, "err": err}.items() if v}),
            status_code=303,
        )

    @app.post("/admin/invite")
    def admin_invite(key: str = Form(...), count: str = Form("1")):
        if not admin_ok(key):
            return RedirectResponse("/", status_code=303)
        try:
            wanted = int(count)
        except ValueError:
            return admin_back(key, err="Give me a number, like 16.")
        if not 1 <= wanted <= 100:
            return admin_back(key, err="Between 1 and 100 links at a time, please.")
        try:
            for _ in range(wanted):
                engine.add_player(game_id(), name=None)
        except GotchaError as exc:
            return admin_back(key, err=str(exc))
        return admin_back(key, msg=f"Created {wanted} invite link(s). Send one to each person.")

    @app.post("/admin/kick")
    def admin_kick(key: str = Form(...), name: str = Form("")):
        if not admin_ok(key):
            return RedirectResponse("/", status_code=303)
        try:
            player = engine.find_player_by_name(game_id(), name)
            removed = engine.remove_player(game_id(), player.id)
        except GotchaError as exc:
            return admin_back(key, err=str(exc))
        return admin_back(key, msg=f"Removed {removed}.")

    @app.post("/admin/begin")
    def admin_begin(key: str = Form(...)):
        if not admin_ok(key):
            return RedirectResponse("/", status_code=303)
        try:
            missions = engine.generate_assignments(game_id())
        except GotchaError as exc:
            return admin_back(key, err=str(exc))
        # The missions are NOT rendered. Web players read theirs on their own
        # page; Telegram players get a DM only if the bot is what started the
        # game, otherwise they simply send /mission.
        telegram_only = [m.player_name for m in missions if m.telegram_id]
        count = len(missions)
        del missions
        note = f"Missions generated for {count} players. Everyone can see theirs on their own page."
        if telegram_only:
            note += " Telegram players: ask them to send /mission to the bot."
        return admin_back(key, msg=note)

    return app


app = None  # created by run_web.py so the DB path is read at startup


def main() -> None:
    import uvicorn

    key = os.environ.get("GOTCHA_ADMIN_KEY") or secrets.token_urlsafe(12)
    host = os.environ.get("GOTCHA_WEB_HOST", "0.0.0.0")
    port = int(os.environ.get("GOTCHA_WEB_PORT", "8000"))
    application = create_app(admin_key=key)
    print("\n  Gotcha web app")
    print(f"  public feed : http://localhost:{port}/")
    print(f"  admin page  : http://localhost:{port}/admin?key={key}")
    print("  (set GOTCHA_ADMIN_KEY to keep the same key between restarts)\n")
    uvicorn.run(application, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
