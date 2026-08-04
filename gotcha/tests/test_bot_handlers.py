"""Handler-level tests for the Telegram bot - no network, no token, no phone.

The bot is the part we actually run, so it gets tested like the engine does. The
handlers are called directly with stand-in Update/Context objects that record
every message the bot tried to send, which lets us assert three things:

1. the *behaviour* (who gets told what, who is refused);
2. that no secret goes anywhere it shouldn't;
3. that every outgoing message is valid Telegram HTML - because a message that
   fails to parse is a message Telegram silently refuses to deliver, and losing
   a mission DM that way would wreck the game.
"""

from __future__ import annotations

import asyncio
import html
import re
from html.parser import HTMLParser
from typing import List, Optional

import pytest
from telegram.constants import ChatType
from telegram.error import TelegramError

from gotcha import telegram_bot as bot


# ---------------------------------------------------------------------------
# "is this really valid Telegram HTML?"
# ---------------------------------------------------------------------------

# https://core.telegram.org/bots/api#html-style
ALLOWED_TAGS = {
    "b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "span",
    "tg-spoiler", "tg-emoji", "a", "code", "pre", "blockquote",
}
TAG_RE = re.compile(r"</?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?>")
BARE_AMP_RE = re.compile(r"&(?!(?:amp|lt|gt|quot|#\d+);)")


def assert_valid_telegram_html(text: str) -> None:
    """Fail if Telegram's HTML parser would reject this message.

    Catches exactly the bug class this suite exists for: a player's name or word
    leaking a stray '<' or '&' into a message and making it undeliverable.
    """
    assert not BARE_AMP_RE.search(text), f"unescaped '&' in message: {text!r}"

    # Every '<' must begin a well-formed tag; a stray one is an error for Telegram
    # even though Python's lenient parser would treat it as text.
    for index, char in enumerate(text):
        if char == "<":
            assert TAG_RE.match(text, index), f"stray '<' in message: {text!r}"

    stack: List[str] = []
    problems: List[str] = []

    class Checker(HTMLParser):
        def handle_starttag(self, tag, attrs):
            if tag not in ALLOWED_TAGS:
                problems.append(f"tag <{tag}> is not supported by Telegram")
            stack.append(tag)

        def handle_endtag(self, tag):
            if not stack or stack[-1] != tag:
                problems.append(f"unbalanced </{tag}>")
            elif stack:
                stack.pop()

    Checker().feed(text)
    assert not problems, f"{problems} in message: {text!r}"
    assert not stack, f"unclosed tags {stack} in message: {text!r}"


def test_the_html_validator_actually_catches_things():
    """A test for the test: prove it would have caught the bug we fixed."""
    assert_valid_telegram_html("plain text")
    assert_valid_telegram_html("<b>bold</b> and <code>code</code> &amp; entities")
    with pytest.raises(AssertionError):
        assert_valid_telegram_html("Ana <b>is out")           # unclosed
    with pytest.raises(AssertionError):
        assert_valid_telegram_html("Tom & Jerry")             # bare ampersand
    with pytest.raises(AssertionError):
        assert_valid_telegram_html("5 < 6")                   # stray '<'
    with pytest.raises(AssertionError):
        assert_valid_telegram_html("<script>x</script>")      # tag Telegram rejects


# ---------------------------------------------------------------------------
# stand-ins for Telegram
# ---------------------------------------------------------------------------


class Sent:
    def __init__(self, chat_id, text, parse_mode=None, markup=None, kind="message"):
        self.chat_id = chat_id
        self.text = text
        self.parse_mode = parse_mode
        self.markup = markup
        self.kind = kind

    def __repr__(self):  # pragma: no cover - debugging aid
        return f"Sent(to={self.chat_id}, {self.text[:60]!r})"


class FakeBot:
    """Records outgoing messages; can pretend a user has blocked the bot."""

    def __init__(self, harness):
        self.harness = harness
        self.blocked = set()

    async def send_message(self, chat_id, text, parse_mode=None, reply_markup=None):
        if chat_id in self.blocked:
            raise TelegramError("Forbidden: bot was blocked by the user")
        self.harness.record(Sent(chat_id, text, parse_mode, reply_markup))


class FakeChat:
    def __init__(self, chat_id, chat_type):
        self.id = chat_id
        self.type = chat_type


class FakeMessage:
    def __init__(self, harness, chat, text):
        self.harness = harness
        self.chat = chat
        self.text = text

    async def reply_text(self, text, parse_mode=None, reply_markup=None):
        self.harness.record(Sent(self.chat.id, text, parse_mode, reply_markup, kind="reply"))


class FakeCallbackQuery:
    def __init__(self, harness, chat, data):
        self.harness = harness
        self.chat = chat
        self.data = data

    async def answer(self):
        pass

    async def edit_message_text(self, text, parse_mode=None, reply_markup=None):
        self.harness.record(Sent(self.chat.id, text, parse_mode, reply_markup, kind="edit"))


class FakeUser:
    def __init__(self, user_id, full_name):
        self.id = user_id
        self.full_name = full_name
        self.first_name = full_name.split()[0] if full_name else "Someone"


class FakeUpdate:
    def __init__(self, user, chat, message=None, callback_query=None):
        self.effective_user = user
        self.effective_chat = chat
        self.effective_message = message
        self.callback_query = callback_query


class FakeApplication:
    def __init__(self, engine, admin_ids):
        self.bot_data = {"engine": engine, "admin_ids": set(admin_ids)}


class FakeContext:
    def __init__(self, harness, args=None, user_data=None):
        self.application = harness.application
        self.bot = harness.bot
        self.args = list(args or [])
        self.user_data = user_data if user_data is not None else {}


class Harness:
    """Drives handlers and remembers everything the bot sent."""

    def __init__(self, engine, admin_ids=()):
        self.engine = engine
        self.application = FakeApplication(engine, admin_ids)
        self.bot = FakeBot(self)
        self.sent: List[Sent] = []
        self._user_data = {}

    def record(self, sent: Sent) -> None:
        # Every HTML message is validated the moment it is "sent", so any handler
        # that builds a broken message fails the test that exercised it.
        if sent.parse_mode == "HTML":
            assert_valid_telegram_html(sent.text)
        self.sent.append(sent)

    # -- driving handlers -------------------------------------------------

    def call(self, handler, user_id, name="Somebody", args=None, text="", private=True):
        chat_type = ChatType.PRIVATE if private else ChatType.GROUP
        chat = FakeChat(user_id if private else -100123, chat_type)
        user = FakeUser(user_id, name)
        message = FakeMessage(self, chat, text)
        update = FakeUpdate(user, chat, message=message)
        context = FakeContext(self, args=args, user_data=self._user_data.setdefault(user_id, {}))
        asyncio.run(handler(update, context))
        return self

    def tap(self, handler, user_id, data, name="Somebody"):
        chat = FakeChat(user_id, ChatType.PRIVATE)
        user = FakeUser(user_id, name)
        query = FakeCallbackQuery(self, chat, data)
        update = FakeUpdate(user, chat, message=None, callback_query=query)
        context = FakeContext(self, user_data=self._user_data.setdefault(user_id, {}))
        asyncio.run(handler(update, context))
        return self

    # -- inspecting what was sent ----------------------------------------

    @property
    def last(self) -> Sent:
        return self.sent[-1]

    def texts(self, chat_id: Optional[int] = None) -> List[str]:
        return [s.text for s in self.sent if chat_id is None or s.chat_id == chat_id]

    def clear(self):
        self.sent = []
        return self


@pytest.fixture()
def harness(engine):
    return Harness(engine, admin_ids={1})  # user 1 is the admin/operator


def join(harness, user_id, name, word):
    harness.call(bot.cmd_join, user_id, name=name)
    harness.call(bot.on_text, user_id, name=name, text=word)


# ---------------------------------------------------------------------------
# joining and submitting a word
# ---------------------------------------------------------------------------


def test_join_then_word_in_a_private_chat(harness):
    harness.engine.create_game("Test")
    harness.call(bot.cmd_join, 42, name="Ana")
    assert "Welcome" in harness.last.text
    harness.call(bot.on_text, 42, name="Ana", text="pineapple")

    player = harness.engine.storage.player_by_telegram(harness.engine.current_game().id, 42)
    assert player.name == "Ana"
    assert player.word == "pineapple"
    # The confirmation must not echo the word back where a shoulder-surfer sees it.
    assert "pineapple" not in harness.last.text
    assert "locked in" in harness.last.text


def test_join_is_refused_in_a_group(harness):
    harness.engine.create_game("Test")
    harness.call(bot.cmd_join, 42, name="Ana", private=False)
    assert "private chat" in harness.last.text
    assert harness.engine.storage.players(harness.engine.current_game().id) == []


def test_word_is_refused_in_a_group(harness):
    harness.engine.create_game("Test")
    harness.call(bot.cmd_join, 42, name="Ana")
    harness.call(bot.cmd_word, 42, name="Ana", args=["pineapple"], private=False)
    assert "Not in public" in harness.last.text
    player = harness.engine.storage.player_by_telegram(harness.engine.current_game().id, 42)
    assert not player.has_word


def test_second_join_does_not_duplicate_the_player(harness):
    harness.engine.create_game("Test")
    join(harness, 42, "Ana", "pineapple")
    harness.call(bot.cmd_join, 42, name="Ana")
    assert "your word is submitted" in harness.last.text
    assert len(harness.engine.storage.players(harness.engine.current_game().id)) == 1


# ---------------------------------------------------------------------------
# the bug this work was about: names and words that break message formatting
# ---------------------------------------------------------------------------


HOSTILE = [
    "john_gelb",          # underscore: italics in Markdown
    "*moist*",            # asterisks: bold in Markdown
    "Tom & Jerry",        # ampersand: HTML entity
    "<b>Ana</b>",         # tag injection
    "5 < 6 > 4",          # stray angle brackets
    "back`tick`",         # code span in Markdown
    "[link](http://x)",   # Markdown link
]


@pytest.mark.parametrize("hostile", HOSTILE)
def test_hostile_names_and_words_survive_every_message(harness, hostile):
    """A name or word full of formatting characters must not break delivery.

    Before the switch to escaped HTML this produced messages Telegram refuses to
    parse - which meant the mission DM was never delivered at all.
    """
    # Spaces removed for the word, because the engine caps a word at 3 tokens -
    # that rule is tested elsewhere; here we only care about the punctuation.
    hostile_word = hostile.replace(" ", "")
    harness.engine.create_game("Test")
    join(harness, 42, hostile, hostile_word)     # hostile name AND hostile word
    join(harness, 43, "Ben", "hydrangea")
    join(harness, 44, "Cleo", "kerfuffle")

    game_id = harness.engine.current_game().id
    assert harness.engine.storage.player_by_telegram(game_id, 42).word == hostile_word

    harness.call(bot.cmd_begin, 1, name="Admin")  # user 1 is admin
    assert harness.engine.current_status(game_id).game.is_active

    # Everybody got a real mission DM (validated as HTML by Harness.record).
    dm_targets = {s.chat_id for s in harness.sent if "Your mission" in s.text}
    assert dm_targets == {42, 43, 44}

    # Whoever is hunting the hostile name sees it intact once un-escaped, and
    # whoever holds the hostile word sees that intact too.
    hunter_of_hostile = next(
        p for p in harness.engine.storage.players(game_id)
        if p.target_id == harness.engine.storage.player_by_telegram(game_id, 42).id
    )
    harness.clear().call(bot.cmd_mission, hunter_of_hostile.telegram_id, name=hunter_of_hostile.name)
    assert hostile in html.unescape(harness.last.text)

    holder = next(
        p for p in harness.engine.storage.players(game_id) if p.mission_word == hostile_word
    )
    harness.clear().call(bot.cmd_mission, holder.telegram_id, name=holder.name)
    assert hostile_word in html.unescape(harness.last.text)

    # And every public view survives it too (Harness.record validates each one).
    harness.clear()
    harness.call(bot.cmd_status, 43, name="Ben")
    harness.call(bot.cmd_players, 43, name="Ben")
    harness.call(bot.cmd_lobby, 1, name="Admin")
    assert html.escape(hostile, quote=False) in " ".join(harness.texts())


def test_a_player_cannot_inject_formatting_into_other_peoples_messages(harness):
    """Escaping means a chosen name is text, never markup, for everyone else."""
    harness.engine.create_game("Test")
    join(harness, 42, "<b>Ana</b>", "pineapple")
    join(harness, 43, "Ben", "hydrangea")
    harness.call(bot.cmd_begin, 1, name="Admin")

    harness.clear().call(bot.cmd_players, 43, name="Ben")
    # The injected tag appears escaped, so it renders as text, not as bold.
    assert "&lt;b&gt;Ana&lt;/b&gt;" in harness.last.text
    assert "<b>Ana</b>" not in harness.last.text


# ---------------------------------------------------------------------------
# missions
# ---------------------------------------------------------------------------


def test_mission_is_private_only(harness):
    harness.engine.create_game("Test")
    join(harness, 42, "Ana", "pineapple")
    join(harness, 43, "Ben", "hydrangea")
    harness.call(bot.cmd_begin, 1, name="Admin")

    harness.clear().call(bot.cmd_mission, 42, name="Ana", private=False)
    assert "privately" in harness.last.text
    mission = harness.engine.get_mission(
        harness.engine.storage.player_by_telegram(harness.engine.current_game().id, 42).id
    )
    assert mission.word not in harness.last.text

    harness.clear().call(bot.cmd_mission, 42, name="Ana")
    assert mission.target_name in harness.last.text
    assert mission.word in harness.last.text
    assert harness.last.chat_id == 42


def test_begin_requires_admin(harness):
    harness.engine.create_game("Test")
    join(harness, 42, "Ana", "pineapple")
    join(harness, 43, "Ben", "hydrangea")

    harness.clear().call(bot.cmd_begin, 42, name="Ana")  # not the admin
    assert "admin command" in harness.last.text
    assert harness.engine.current_status(harness.engine.current_game().id).game.is_lobby


def test_claimadmin_when_no_admin_is_configured(engine):
    harness = Harness(engine, admin_ids=())  # nobody configured
    engine.create_game("Test")
    join(harness, 42, "Ana", "pineapple")
    join(harness, 43, "Ben", "hydrangea")

    harness.clear().call(bot.cmd_claimadmin, 42, name="Ana")
    assert "You are the admin" in harness.texts()[0]
    harness.clear().call(bot.cmd_claimadmin, 43, name="Ben")
    assert "already been claimed" in harness.last.text

    harness.clear().call(bot.cmd_begin, 42, name="Ana")
    assert engine.current_status(engine.current_game().id).game.is_active


def test_begin_names_the_players_it_could_not_reach(harness):
    harness.engine.create_game("Test")
    join(harness, 42, "Ana", "pineapple")
    join(harness, 43, "Ben", "hydrangea")
    join(harness, 44, "Cleo", "kerfuffle")
    harness.bot.blocked.add(43)  # Ben blocked the bot / never pressed start

    harness.clear().call(bot.cmd_begin, 1, name="Admin")
    admin_note = next(s.text for s in harness.sent if "Missions generated" in s.text)
    assert "DM'd to 2 players" in admin_note
    assert "Ben" in admin_note
    assert "/reroll" in admin_note
    # The game still started - the admin can fix Ben and re-roll.
    assert harness.engine.current_status(harness.engine.current_game().id).game.is_active


def test_no_bot_message_ever_contains_someone_elses_word(harness):
    harness.engine.create_game("Test")
    # Deliberately odd words: the /join help text mentions "pineapple" as an
    # example, which would make this check fire on the help text itself.
    join(harness, 42, "Ana", "zibbet")
    join(harness, 43, "Ben", "quorval")
    join(harness, 44, "Cleo", "thrumble")
    harness.clear().call(bot.cmd_begin, 1, name="Admin")

    game_id = harness.engine.current_game().id
    for sent in harness.sent:
        if sent.chat_id in (42, 43, 44):
            player = harness.engine.storage.player_by_telegram(game_id, sent.chat_id)
            mine = {(player.mission_word or "").lower()}
            for other in harness.engine.storage.players(game_id):
                word = (other.mission_word or "").lower()
                if word and word not in mine:
                    assert word not in sent.text.lower(), (
                        f"player {sent.chat_id} was sent somebody else's word"
                    )


# ---------------------------------------------------------------------------
# gotcha -> confirm -> inherit
# ---------------------------------------------------------------------------


def _start_three(harness):
    harness.engine.create_game("Test")
    join(harness, 42, "Ana", "pineapple")
    join(harness, 43, "Ben", "hydrangea")
    join(harness, 44, "Cleo", "kerfuffle")
    harness.call(bot.cmd_begin, 1, name="Admin")
    game_id = harness.engine.current_game().id
    return game_id, {
        tid: harness.engine.storage.player_by_telegram(game_id, tid) for tid in (42, 43, 44)
    }


def test_gotcha_on_the_wrong_person_is_rejected(harness):
    game_id, players = _start_three(harness)
    hunter = players[42]
    mission = harness.engine.get_mission(hunter.id)
    wrong = next(p for p in players.values() if p.id not in (hunter.id, mission.target_id))

    harness.clear().call(bot.cmd_gotcha, 42, name="Ana", args=[wrong.name])
    assert "not your target" in harness.last.text
    assert harness.engine.pending_reports(game_id) == []


def test_gotcha_files_a_claim_and_asks_the_others(harness):
    game_id, players = _start_three(harness)
    hunter = players[42]
    mission = harness.engine.get_mission(hunter.id)

    harness.clear().call(bot.cmd_gotcha, 42, name="Ana", args=[mission.target_name])
    assert "Claim filed" in harness.texts(42)[0]
    # Everyone except the reporter is nudged to come and confirm.
    nudged = {s.chat_id for s in harness.sent if "If you saw or believe it" in s.text}
    assert nudged == {43, 44}, "the reporter must not be asked to confirm their own claim"
    assert len(harness.engine.pending_reports(game_id)) == 1


def test_reporter_cannot_confirm_their_own_claim(harness):
    game_id, players = _start_three(harness)
    mission = harness.engine.get_mission(players[42].id)
    harness.call(bot.cmd_gotcha, 42, name="Ana", args=[mission.target_name])

    harness.clear().call(bot.cmd_confirm, 42, name="Ana")
    assert "somebody else has to confirm" in harness.last.text

    report = harness.engine.pending_reports(game_id)[0]
    harness.clear().tap(bot.on_confirm_button, 42, f"confirm:{report.id}", name="Ana")
    assert "cannot confirm your own" in harness.last.text
    assert harness.engine.current_status(game_id).alive_count == 3


def test_confirm_button_eliminates_announces_and_hands_over_the_mission(harness):
    game_id, players = _start_three(harness)
    hunter = players[42]
    mission = harness.engine.get_mission(hunter.id)
    victim = next(p for p in players.values() if p.id == mission.target_id)
    victim_mission = harness.engine.get_mission(victim.id)
    witness = next(p for p in players.values() if p.id not in (hunter.id, victim.id))

    harness.call(bot.cmd_gotcha, 42, name="Ana", args=[mission.target_name])
    report = harness.engine.pending_reports(game_id)[0]
    harness.clear().tap(bot.on_confirm_button, witness.telegram_id, f"confirm:{report.id}")

    # public announcement to everybody (no feed chat configured yet)
    announcements = [s for s in harness.sent if "is out!" in s.text]
    assert {s.chat_id for s in announcements} == {42, 43, 44}
    assert "(2 left)" in announcements[0].text

    # the victim is told, privately
    assert any(s.chat_id == victim.telegram_id and "You are out" in s.text for s in harness.sent)

    # the hunter privately inherits the victim's target AND word
    handover = next(s for s in harness.sent if "you inherit their mission" in s.text.lower())
    assert handover.chat_id == hunter.telegram_id
    assert victim_mission.target_name in handover.text
    assert victim_mission.word in handover.text
    assert harness.engine.get_mission(hunter.id).word == victim_mission.word


def test_an_undelivered_inherited_mission_is_never_silent(harness):
    """If the hunter has blocked the bot, say so publicly instead of losing it."""
    game_id, players = _start_three(harness)
    hunter = players[42]
    mission = harness.engine.get_mission(hunter.id)
    witness = next(
        p for p in players.values() if p.id not in (hunter.id, mission.target_id)
    )
    harness.call(bot.cmd_gotcha, 42, name="Ana", args=[mission.target_name])
    report = harness.engine.pending_reports(game_id)[0]

    harness.bot.blocked.add(hunter.telegram_id)
    harness.clear().tap(bot.on_confirm_button, witness.telegram_id, f"confirm:{report.id}")

    nudge = [s for s in harness.sent if "could not DM you your new mission" in s.text]
    assert nudge, "a lost mission handover must be announced, not swallowed"
    assert "/mission" in nudge[0].text


def test_the_winner_is_announced_when_two_players_are_left(harness):
    harness.engine.create_game("Test")
    join(harness, 42, "Ana", "pineapple")
    join(harness, 43, "Ben", "hydrangea")
    harness.call(bot.cmd_begin, 1, name="Admin")
    game_id = harness.engine.current_game().id

    hunter = harness.engine.storage.player_by_telegram(game_id, 42)
    mission = harness.engine.get_mission(hunter.id)
    harness.call(bot.cmd_gotcha, 42, name="Ana", args=[mission.target_name])
    report = harness.engine.pending_reports(game_id)[0]

    harness.clear().tap(bot.on_confirm_button, 43, f"confirm:{report.id}", name="Ben")
    assert any("wins Gotcha" in s.text for s in harness.sent)
    assert harness.engine.winner(game_id).id == hunter.id
    # No new mission was handed to the winner.
    assert not any("Your mission" in s.text for s in harness.sent)
    harness.clear().call(bot.cmd_mission, 42, name="Ana")
    assert "game is over" in harness.last.text


def test_eliminated_player_can_still_confirm(harness):
    game_id, players = _start_three(harness)
    hunter = players[42]
    mission = harness.engine.get_mission(hunter.id)
    victim = next(p for p in players.values() if p.id == mission.target_id)
    witness = next(p for p in players.values() if p.id not in (hunter.id, victim.id))

    harness.call(bot.cmd_gotcha, 42, name="Ana", args=[mission.target_name])
    first = harness.engine.pending_reports(game_id)[0]
    harness.tap(bot.on_confirm_button, witness.telegram_id, f"confirm:{first.id}")

    # Now the hunter reports the inherited target, and the dead player confirms.
    next_mission = harness.engine.get_mission(hunter.id)
    harness.call(bot.cmd_gotcha, 42, name="Ana", args=[next_mission.target_name])
    second = harness.engine.pending_reports(game_id)[0]
    harness.clear().tap(bot.on_confirm_button, victim.telegram_id, f"confirm:{second.id}")
    assert any("wins Gotcha" in s.text for s in harness.sent)


# ---------------------------------------------------------------------------
# the group feed
# ---------------------------------------------------------------------------


def test_setfeed_routes_announcements_to_the_group(harness):
    game_id, players = _start_three(harness)
    harness.call(bot.cmd_setfeed, 1, name="Admin", private=False)
    assert "Announcements will be posted here" in harness.last.text

    hunter = players[42]
    mission = harness.engine.get_mission(hunter.id)
    witness = next(p for p in players.values() if p.id not in (hunter.id, mission.target_id))
    harness.call(bot.cmd_gotcha, 42, name="Ana", args=[mission.target_name])
    report = harness.engine.pending_reports(game_id)[0]
    harness.clear().tap(bot.on_confirm_button, witness.telegram_id, f"confirm:{report.id}")

    # `kind="edit"` is the button's own feedback to the tapper, not a broadcast.
    elimination = [s for s in harness.sent if "is out!" in s.text and s.kind != "edit"]
    assert len(elimination) == 1, "the announcement should go to the group, once"
    assert elimination[0].chat_id == -100123  # the group chat
    assert not [s for s in elimination if s.chat_id in (42, 43, 44)], "no DM storm"

    # And the group never receives a mission.
    group_texts = " ".join(harness.texts(-100123))
    for player in harness.engine.storage.players(game_id):
        if player.mission_word:
            assert player.mission_word not in group_texts


def test_setfeed_refuses_in_a_private_chat(harness):
    harness.engine.create_game("Test")
    harness.call(bot.cmd_setfeed, 1, name="Admin")
    assert "inside the group chat" in harness.last.text


def test_status_in_a_group_is_public_information_only(harness):
    game_id, players = _start_three(harness)
    harness.clear().call(bot.cmd_status, 42, name="Ana", private=False)
    text = harness.last.text
    for player in harness.engine.storage.players(game_id):
        assert player.word not in text
        assert player.mission_word not in text
    assert "Alive" in text


# ---------------------------------------------------------------------------
# operational errors: readable, not a wall of traceback
# ---------------------------------------------------------------------------


class ErrorContext(FakeContext):
    def __init__(self, harness, error):
        super().__init__(harness)
        self.error = error


def test_two_running_copies_gets_one_readable_line(harness, caplog):
    """Telegram allows one connection per token; say so in plain language."""
    from telegram.error import Conflict

    with caplog.at_level("ERROR"):
        asyncio.run(bot.on_error(None, ErrorContext(harness, Conflict("terminated by other"))))
    message = caplog.records[-1].getMessage()
    assert "only allows one" in message
    assert "pkill -f run_bot.py" in message
    assert "Nothing is lost" in message
    assert caplog.records[-1].exc_info is None, "no traceback for a config problem"

    # It says the long version once, then stops repeating itself.
    caplog.clear()
    with caplog.at_level("ERROR"):
        asyncio.run(bot.on_error(None, ErrorContext(harness, Conflict("again"))))
    assert "Still fighting" in caplog.records[-1].getMessage()


def test_a_network_blip_is_a_warning_not_a_crash(harness, caplog):
    from telegram.error import NetworkError

    with caplog.at_level("WARNING"):
        asyncio.run(bot.on_error(None, ErrorContext(harness, NetworkError("wifi died"))))
    message = caplog.records[-1].getMessage()
    assert "retrying automatically" in message
    assert caplog.records[-1].levelname == "WARNING"


def test_a_real_bug_still_gets_its_traceback(harness, caplog):
    with caplog.at_level("ERROR"):
        asyncio.run(bot.on_error(None, ErrorContext(harness, ValueError("a real bug"))))
    assert caplog.records[-1].exc_info is not None
