"""Telegram interface (interface #1 - the one we run this weekend).

Uses LONG POLLING: the bot phones Telegram and asks "anything for me?". That
means it works from a laptop at home behind any router - no port forwarding, no
public IP, no inbound ports open.

Privacy rules baked in here:
* Anything secret (your word, your mission) is only ever sent in a 1:1 chat with
  the bot. Commands that would reveal a secret refuse to answer in a group.
* Nothing secret is written to the log. The logging below records *who* did
  *what kind of* action, never a word or a target.
* There is no admin command that prints the assignment map. It does not exist.

FORMATTING - WHY HTML AND NOT MARKDOWN
--------------------------------------
Every message goes out with `parse_mode=HTML`, and every piece of player-supplied
text (names, words) is passed through `esc()` first.

This is not a style preference. Telegram parses formatting *before* delivering,
so a player called "john_gelb" or a word like "*moist*" injected raw into a
Markdown message makes the message unparseable - Telegram rejects it and the
message is never delivered. Silently losing the message that contains somebody's
mission is the worst possible failure for this game. HTML escaping (`&`, `<`, `>`
-> entities) is unambiguous and total, so no name or word can break a message.

Rule for anyone editing this file: dynamic text is ALWAYS wrapped in esc().
"""

from __future__ import annotations

import html
import logging
import os
from typing import List, Optional

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.constants import ChatType, ParseMode
from telegram.error import TelegramError
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from .engine import GotchaEngine, GotchaError
from .models import MissionDelivery
from .storage import Storage

log = logging.getLogger("gotcha.telegram")

FEED_CHAT_KEY = "feed_chat_id"
ADMIN_KEY = "claimed_admin_ids"


def esc(value) -> str:
    """Make any text safe to drop into a Telegram HTML message.

    Wrap EVERY name, word, game title and engine message in this. See the module
    docstring for why an unescaped name can stop a mission being delivered.
    """
    return html.escape(str(value if value is not None else ""), quote=False)


HELP_PLAYER = """<b>Gotcha</b> - the word assassin game.

Everyone submits one word. You get a secret mission: <b>a person</b> + <b>a word</b>.
Get that person to say that word in normal conversation, then report it. When it
is confirmed they are out, and you inherit their mission - their target and their
word become yours. Last player standing wins.

<b>Your commands</b> (use them here, in our private chat):
/join - join the game
/word <code>&lt;your word&gt;</code> - submit or change your word (before the game starts)
/mission - show my current target and word
/gotcha <code>&lt;name&gt;</code> - claim you got your target to say your word
/withdraw - take back a claim you just made
/confirm - witness someone else's claim
/status - who is still alive, and the kill feed
/players - who has joined
/help - this message
"""

HELP_ADMIN = """<b>Admin commands</b>
/lobby - join progress (names only - never words, never assignments)
/kick <code>&lt;name&gt;</code> - remove a no-show (before the game starts)
/begin - generate the chain and DM everyone their first mission
/reroll - regenerate and re-DM (only before the first elimination)
/setfeed - run this <b>inside a group</b> to send announcements there
/newgame <code>&lt;name&gt;</code> - start a fresh game
/whoami - show your Telegram user id

Note: Telegram reserves /start for "say hello to the bot", so the game is
started with <b>/begin</b>.

There is deliberately no command that shows you who hunts whom. You are playing
too - you get exactly the same information as everybody else.
"""


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------


def _engine(context: ContextTypes.DEFAULT_TYPE) -> GotchaEngine:
    return context.application.bot_data["engine"]


def _game_id(context: ContextTypes.DEFAULT_TYPE) -> int:
    engine = _engine(context)
    return engine.get_or_create_game(os.environ.get("GOTCHA_GAME_NAME", "Gotcha")).id


def _is_private(update: Update) -> bool:
    chat = update.effective_chat
    return bool(chat and chat.type == ChatType.PRIVATE)


def _is_admin(update: Update, context: ContextTypes.DEFAULT_TYPE) -> bool:
    user = update.effective_user
    if not user:
        return False
    if user.id in context.application.bot_data["admin_ids"]:
        return True
    claimed = _engine(context).storage.get_setting(_game_id(context), ADMIN_KEY) or ""
    return str(user.id) in [x for x in claimed.split(",") if x]


async def _reply(update: Update, text: str, **kwargs) -> None:
    """Answer whoever sent this update. Text must already be HTML-escaped."""
    kwargs.setdefault("parse_mode", ParseMode.HTML)
    if update.effective_message:
        await update.effective_message.reply_text(text, **kwargs)
    elif update.callback_query:
        await update.callback_query.edit_message_text(text, **kwargs)


def _mission_text(mission, heading: str = "🎯 <b>Your mission</b>") -> str:
    return (
        f"{heading}\n"
        f"Target: <b>{esc(mission.target_name)}</b>\n"
        f"Word: <b>{esc(mission.word)}</b>\n\n"
        "Get them to say it out loud in normal conversation, then send "
        f"<code>/gotcha {esc(mission.target_name)}</code>.\n"
        "<i>Keep this to yourself.</i>"
    )


async def _dm(context: ContextTypes.DEFAULT_TYPE, telegram_id: Optional[int], text: str) -> bool:
    """Send a private HTML message; False if Telegram would not deliver it."""
    if not telegram_id:
        return False
    try:
        await context.bot.send_message(chat_id=telegram_id, text=text, parse_mode=ParseMode.HTML)
        return True
    except TelegramError as exc:
        # No secret is logged here - only the fact that a delivery failed.
        log.warning("Could not DM user %s: %s", telegram_id, exc.__class__.__name__)
        return False


async def _deliver_mission(
    context: ContextTypes.DEFAULT_TYPE,
    mission: MissionDelivery,
    heading: str = "🎯 <b>Your mission</b>",
) -> bool:
    return await _dm(context, mission.telegram_id, _mission_text(mission, heading))


async def _announce(context: ContextTypes.DEFAULT_TYPE, game_id: int, text: str) -> None:
    """Publish a public announcement (eliminations, winner).

    Goes to the group chat if the admin ran /setfeed there; otherwise it is DM'd
    to every player so nobody misses it.
    """
    engine = _engine(context)
    feed_chat = engine.storage.get_setting(game_id, FEED_CHAT_KEY)
    if feed_chat:
        try:
            await context.bot.send_message(
                chat_id=int(feed_chat), text=text, parse_mode=ParseMode.HTML
            )
            return
        except TelegramError as exc:
            log.warning("Feed chat delivery failed (%s); falling back to DMs.", exc.__class__.__name__)
    for player in engine.storage.players(game_id):
        await _dm(context, player.telegram_id, text)


def _me(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """The player row for whoever sent this update, or None if not joined."""
    engine = _engine(context)
    user = update.effective_user
    if not user:
        return None
    return engine.storage.player_by_telegram(_game_id(context), user.id)


# ---------------------------------------------------------------------------
# player commands
# ---------------------------------------------------------------------------


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_private(update):
        await _reply(update, "Message me privately to play: tap my name, then /join.")
        return
    await _reply(update, HELP_PLAYER)
    if _is_admin(update, context):
        await _reply(update, HELP_ADMIN)


async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await cmd_start(update, context)


async def cmd_join(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_private(update):
        await _reply(update, "Join in a private chat with me, so your word stays secret.")
        return
    engine = _engine(context)
    game_id = _game_id(context)
    user = update.effective_user
    name = " ".join(context.args) if context.args else (user.full_name or user.first_name)

    try:
        player = engine.add_player(game_id, name=name.strip()[:40], telegram_id=user.id)
    except GotchaError as exc:
        await _reply(update, f"⚠️ {esc(exc)}")
        return

    if player.has_word:
        await _reply(
            update,
            f"You are in as <b>{esc(player.display_name)}</b> and your word is submitted. "
            "Use /word to change it while we wait.",
        )
        return

    context.user_data["awaiting_word"] = True
    await _reply(
        update,
        f"Welcome, <b>{esc(player.display_name)}</b>! 🎉\n\n"
        "Now send me <b>one word</b> - the word other people will be tricked into "
        'saying. Pick something sayable but not too common ("pineapple", not "the").\n\n'
        "Just type the word as your next message.",
    )


async def cmd_word(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_private(update):
        await _reply(update, "Not in public! Send your word to me in a private chat.")
        return
    if not context.args:
        await _reply(update, "Usage: <code>/word pineapple</code>")
        return
    await _accept_word(update, context, " ".join(context.args))


async def on_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Plain text in a private chat: usually somebody's word."""
    if not _is_private(update) or not update.effective_message:
        return
    text = (update.effective_message.text or "").strip()
    if not text:
        return
    player = _me(update, context)
    if player is None:
        await _reply(update, "Send /join first and I will explain everything.")
        return
    if context.user_data.get("awaiting_word") or not player.has_word:
        await _accept_word(update, context, text)
        return
    await _reply(update, "Not sure what you meant - try /mission, /status or /help.")


async def _accept_word(update: Update, context: ContextTypes.DEFAULT_TYPE, word: str) -> None:
    engine = _engine(context)
    player = _me(update, context)
    if player is None:
        await _reply(update, "Send /join first.")
        return
    try:
        engine.submit_word(player.id, word)
    except GotchaError as exc:
        await _reply(update, f"⚠️ {esc(exc)}")
        return
    context.user_data["awaiting_word"] = False
    status = engine.current_status(player.game_id)
    log.info("player %s submitted a word", player.id)  # never log the word itself
    await _reply(
        update,
        "Got it - your word is locked in and nobody else can see it. 🤐\n"
        f"{status.ready_count} of {status.joined_count} players are ready.\n\n"
        "Change it any time before the game starts with <code>/word something-else</code>. "
        "I will DM you your mission when the game begins.",
    )


async def cmd_mission(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_private(update):
        await _reply(update, "Ask me privately 🙂")
        return
    engine = _engine(context)
    player = _me(update, context)
    if player is None:
        await _reply(update, "You are not in this game. /join first.")
        return
    if not player.alive:
        await _reply(update, "You are out of the game. You can still /confirm other people's claims.")
        return
    mission = engine.get_mission(player.id)
    if mission is None:
        status = engine.current_status(player.game_id)
        if status.game.is_finished:
            await _reply(update, f"The game is over. 🏆 {esc(status.winner_name)} won.")
        else:
            await _reply(update, "No mission yet - the game has not started. Sit tight.")
        return
    await _reply(update, _mission_text(mission))


async def cmd_gotcha(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_private(update):
        await _reply(update, "Report it to me privately: <code>/gotcha Name</code>")
        return
    engine = _engine(context)
    player = _me(update, context)
    if player is None:
        await _reply(update, "You are not in this game.")
        return
    if not context.args:
        await _reply(update, "Usage: <code>/gotcha Ana</code> (must be your current target)")
        return

    try:
        report = engine.report_gotcha(player.game_id, player.id, " ".join(context.args))
    except GotchaError as exc:
        await _reply(update, f"⚠️ {esc(exc)}")
        return

    await _reply(
        update,
        f"📣 Claim filed: you got <b>{esc(report.target_name)}</b> to say "
        f"<b>{esc(report.word)}</b>.\n"
        "Now any other player has to confirm it - ask a witness to send /confirm. "
        "Made a mistake? /withdraw.",
    )
    # Nudge everybody else that there is something to confirm. This reveals the
    # hunter->victim link, which is about to be public anyway (see README).
    for other in engine.storage.players(player.game_id):
        if other.id == player.id:
            continue
        await _dm(
            context,
            other.telegram_id,
            f"❓ <b>{esc(report.reporter_name)}</b> claims <b>{esc(report.target_name)}</b> "
            f"said <b>{esc(report.word)}</b>.\nIf you saw or believe it, send /confirm.",
        )


async def cmd_withdraw(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    engine = _engine(context)
    player = _me(update, context)
    if player is None:
        await _reply(update, "You are not in this game.")
        return
    mine = [r for r in engine.pending_reports(player.game_id) if r.reporter_id == player.id]
    if not mine:
        await _reply(update, "You have no claim waiting.")
        return
    for report in mine:
        engine.cancel_gotcha(player.game_id, report.id, player.id)
    await _reply(update, "Withdrawn. Nothing happened. 🙈")


async def cmd_confirm(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    engine = _engine(context)
    player = _me(update, context)
    if player is None:
        await _reply(update, "Only players can confirm. /join to get involved.")
        return
    reports = engine.confirmable_reports(player.game_id, player.id)
    if not reports:
        pending = engine.pending_reports(player.game_id)
        if pending:
            await _reply(update, "The only claim waiting is your own - somebody else has to confirm it.")
        else:
            await _reply(update, "Nothing to confirm right now.")
        return
    # Button labels are plain text, not HTML - no escaping, and no tags either.
    buttons = [
        [
            InlineKeyboardButton(
                f"✅ {r.reporter_name} got {r.target_name} to say “{r.word}”",
                callback_data=f"confirm:{r.id}",
            )
        ]
        for r in reports
    ]
    await _reply(
        update,
        "Confirm a gotcha (only tap if you believe it really happened):",
        reply_markup=InlineKeyboardMarkup(buttons),
    )


async def on_confirm_button(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    engine = _engine(context)
    player = _me(update, context)
    if player is None:
        await query.edit_message_text("Only players can confirm.")
        return
    report_id = int(query.data.split(":", 1)[1])
    try:
        result = engine.confirm_gotcha(player.game_id, report_id, player.id)
    except GotchaError as exc:
        await query.edit_message_text(f"⚠️ {exc}")
        return

    if result.already_confirmed:
        await query.edit_message_text(f"Already handled: {result.announcement}")
        return

    # edit_message_text without a parse mode: plain text, nothing to escape.
    await query.edit_message_text(f"Confirmed. {result.announcement.splitlines()[0]}")
    log.info("gotcha confirmed: player %s eliminated", result.victim_id)

    # Public announcement, then the private hand-over of the inherited mission.
    await _announce(context, player.game_id, esc(result.announcement))
    await _dm(
        context,
        engine.storage.get_player(result.victim_id).telegram_id,
        f"☠️ You are out - <b>{esc(result.hunter_name)}</b> got you. You can still confirm "
        "other people's gotchas with /confirm, and watch /status.",
    )
    if result.new_mission:
        delivered = await _deliver_mission(
            context,
            result.new_mission,
            heading="🎯 <b>Confirmed - you inherit their mission.</b>",
        )
        if not delivered:
            # Never leave an undelivered mission silent: tell them to come and get it.
            await _announce(
                context,
                player.game_id,
                f"⚠️ {esc(result.hunter_name)}, I could not DM you your new mission - "
                "message me privately and send /mission.",
            )
    if result.game_over:
        await _announce(
            context,
            player.game_id,
            f"🏆 <b>{esc(result.winner_name)}</b> is the last one standing and wins Gotcha!",
        )


async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    engine = _engine(context)
    game_id = _game_id(context)
    status = engine.current_status(game_id)
    lines: List[str] = [f"<b>{esc(status.game.name)}</b> - {esc(status.game.state)}"]
    if status.game.is_lobby:
        lines.append(f"{status.ready_count} of {status.joined_count} players ready.")
    else:
        lines.append(f"Alive: <b>{status.alive_count}</b> | out: {status.eliminated_count}")
        alive = ", ".join(esc(p.name) for p in status.players if p.alive) or "-"
        lines.append(f"Still in: {alive}")
    if status.winner_name:
        lines.append(f"🏆 Winner: <b>{esc(status.winner_name)}</b>")
    if status.pending_count:
        lines.append(f"⏳ {status.pending_count} claim(s) waiting for a witness - /confirm")
    feed = [i for i in status.feed if i.kind in ("elimination", "winner", "started")][:10]
    if feed:
        lines.append("\n<b>Feed</b>")
        lines += [f"• {esc(item.message)}" for item in feed]
    await _reply(update, "\n".join(lines))


async def cmd_players(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    engine = _engine(context)
    status = engine.current_status(_game_id(context))
    if not status.players:
        await _reply(update, "Nobody has joined yet.")
        return
    rows = []
    for p in status.players:
        if status.game.is_lobby:
            rows.append(f"{'✅' if p.ready else '⏳'} {esc(p.name)}")
        else:
            rows.append(f"{'🙂' if p.alive else '💀'} {esc(p.name)}")
    await _reply(update, f"<b>Players ({len(rows)})</b>\n" + "\n".join(rows))


async def cmd_mylink(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Give a player their own private web link (if the web app is running)."""
    if not _is_private(update):
        await _reply(update, "Privately, please.")
        return
    base = os.environ.get("GOTCHA_WEB_BASE", "").rstrip("/")
    player = _me(update, context)
    if player is None:
        await _reply(update, "/join first.")
        return
    if not base:
        await _reply(update, "The web app is not set up for this game - Telegram only.")
        return
    await _reply(
        update,
        f"Your private page: {esc(base)}/p/{esc(player.token)}\n"
        "Do not share this link - it <b>is</b> your identity.",
    )


# ---------------------------------------------------------------------------
# admin commands
# ---------------------------------------------------------------------------


async def _require_admin(update: Update, context: ContextTypes.DEFAULT_TYPE) -> bool:
    if _is_admin(update, context):
        return True
    await _reply(update, "That is an admin command.")
    return False


async def cmd_whoami(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    await _reply(
        update,
        f"Your Telegram user id is <code>{user.id}</code>.\n"
        "Put it in the GOTCHA_ADMIN_IDS setting to become the admin.",
    )


async def cmd_claimadmin(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Become admin when no admin id was configured (first come, first served)."""
    engine = _engine(context)
    game_id = _game_id(context)
    if context.application.bot_data["admin_ids"]:
        await _reply(update, "This bot already has an admin configured (GOTCHA_ADMIN_IDS).")
        return
    claimed = engine.storage.get_setting(game_id, ADMIN_KEY)
    if claimed:
        await _reply(update, "Admin has already been claimed for this game.")
        return
    engine.storage.set_setting(game_id, ADMIN_KEY, str(update.effective_user.id))
    await _reply(update, "You are the admin of this game. ✅")
    await _reply(update, HELP_ADMIN)


async def cmd_lobby(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _require_admin(update, context):
        return
    engine = _engine(context)
    status = engine.current_status(_game_id(context))
    waiting = [p.name for p in status.players if not p.ready]
    lines = [
        f"<b>Lobby</b> - {status.ready_count}/{status.joined_count} ready",
        "Joined: " + (", ".join(esc(p.name) for p in status.players) or "nobody yet"),
    ]
    if waiting:
        lines.append("No word yet: " + ", ".join(esc(n) for n in waiting))
    lines.append("<i>You cannot see anyone's word or assignment - not even as admin.</i>")
    await _reply(update, "\n".join(lines))


async def cmd_kick(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _require_admin(update, context):
        return
    engine = _engine(context)
    game_id = _game_id(context)
    if not context.args:
        await _reply(update, "Usage: <code>/kick Ana</code>")
        return
    try:
        player = engine.find_player_by_name(game_id, " ".join(context.args))
        name = engine.remove_player(game_id, player.id)
    except GotchaError as exc:
        await _reply(update, f"⚠️ {esc(exc)}")
        return
    await _reply(update, f"Removed <b>{esc(name)}</b> from the lobby.")


async def cmd_begin(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Generate the chain and DM everybody their first mission."""
    if not await _require_admin(update, context):
        return
    engine = _engine(context)
    game_id = _game_id(context)
    try:
        # `missions` is the ONLY place the whole map exists. We send it out and
        # then let it fall out of scope. It is never printed, stored or logged.
        missions = engine.generate_assignments(game_id)
    except GotchaError as exc:
        await _reply(update, f"⚠️ Cannot start: {esc(exc)}")
        return

    delivered, failed = 0, []
    for mission in missions:
        if await _deliver_mission(context, mission):
            delivered += 1
        else:
            failed.append(mission.player_name)
    del missions  # be explicit: the map is gone

    await _reply(
        update,
        f"Missions generated and DM'd to {delivered} players. ✅\n"
        + (
            f"⚠️ Could not reach: {', '.join(esc(n) for n in failed)} - they must DM me "
            "/start first, then run /reroll.\n"
            if failed
            else ""
        )
        + "I do not know what to tell you about the assignments, and neither does any "
        "screen. Good luck.",
    )
    await _announce(
        context,
        game_id,
        "🎯 <b>Gotcha has begun!</b> Everyone has a secret target and a secret word. "
        "Check your DMs, and yell it when you get them.",
    )


async def cmd_reroll(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _require_admin(update, context):
        return
    await cmd_begin(update, context)


async def cmd_setfeed(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _require_admin(update, context):
        return
    chat = update.effective_chat
    if chat.type == ChatType.PRIVATE:
        await _reply(update, "Run /setfeed inside the group chat where announcements should go.")
        return
    engine = _engine(context)
    engine.storage.set_setting(_game_id(context), FEED_CHAT_KEY, str(chat.id))
    await _reply(update, "📣 Announcements will be posted here. (Missions never will.)")


async def cmd_newgame(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _require_admin(update, context):
        return
    engine = _engine(context)
    name = " ".join(context.args) if context.args else "Gotcha"
    game = engine.create_game(name)
    await _reply(update, f"New game <b>{esc(game.name)}</b> created. Everybody send /join.")


async def on_error(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    log.exception("Unhandled error in handler", exc_info=context.error)
    if isinstance(update, Update) and update.effective_message:
        try:
            await update.effective_message.reply_text("Something went wrong - try again.")
        except TelegramError:
            pass


# ---------------------------------------------------------------------------
# wiring
# ---------------------------------------------------------------------------


def build_application(token: str, engine: GotchaEngine, admin_ids: Optional[set] = None) -> Application:
    app = Application.builder().token(token).build()
    app.bot_data["engine"] = engine
    app.bot_data["admin_ids"] = set(admin_ids or ())

    handlers = [
        CommandHandler("start", cmd_start),
        CommandHandler("help", cmd_help),
        CommandHandler("join", cmd_join),
        CommandHandler("word", cmd_word),
        CommandHandler("mission", cmd_mission),
        CommandHandler("gotcha", cmd_gotcha),
        CommandHandler("withdraw", cmd_withdraw),
        CommandHandler("confirm", cmd_confirm),
        CommandHandler("status", cmd_status),
        CommandHandler("players", cmd_players),
        CommandHandler("mylink", cmd_mylink),
        CommandHandler("whoami", cmd_whoami),
        CommandHandler("claimadmin", cmd_claimadmin),
        CommandHandler("lobby", cmd_lobby),
        CommandHandler("kick", cmd_kick),
        CommandHandler(["begin", "startgame", "go"], cmd_begin),
        CommandHandler("reroll", cmd_reroll),
        CommandHandler("setfeed", cmd_setfeed),
        CommandHandler("newgame", cmd_newgame),
        CallbackQueryHandler(on_confirm_button, pattern=r"^confirm:\d+$"),
        MessageHandler(filters.TEXT & ~filters.COMMAND & filters.ChatType.PRIVATE, on_text),
    ]
    for handler in handlers:
        app.add_handler(handler)
    app.add_error_handler(on_error)
    return app


def parse_admin_ids(raw: str) -> set:
    return {int(x) for x in raw.replace(" ", "").split(",") if x}


def main() -> None:
    logging.basicConfig(
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        level=logging.INFO,
    )
    # Keep the HTTP library quiet: its debug output would contain message text.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("telegram.ext.Application").setLevel(logging.INFO)

    token = os.environ.get("GOTCHA_BOT_TOKEN", "").strip()
    if not token:
        raise SystemExit(
            "No bot token. Get one from @BotFather in Telegram, then run:\n"
            "  export GOTCHA_BOT_TOKEN='123456:ABC-your-token'\n"
            "  python3 run_bot.py"
        )
    db_path = os.environ.get("GOTCHA_DB", "gotcha.db")
    engine = GotchaEngine(Storage(db_path))
    admin_ids = parse_admin_ids(os.environ.get("GOTCHA_ADMIN_IDS", ""))

    app = build_application(token, engine, admin_ids)
    log.info("Gotcha bot starting (db=%s, admins=%s)", db_path, sorted(admin_ids) or "unclaimed")
    # Long polling: no inbound ports, no public URL needed.
    #
    # drop_pending_updates=False matters for a weekend game run off a laptop.
    # Telegram queues messages sent while the bot is down (for ~24h) and hands
    # them over on reconnect. Dropping them would mean a /gotcha sent at 2am,
    # while the lid was shut, silently never happened. Replaying them is safe:
    # reports and confirmations are idempotent, and a claim that has gone stale
    # in the meantime is voided rather than honoured.
    app.run_polling(drop_pending_updates=False)


if __name__ == "__main__":
    main()
