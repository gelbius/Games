# Gotcha 🎯 — a self-administering word-assassin game

Everyone secretly submits **one word**. Everyone secretly receives a **mission**:
*a person* + *a word*. Your job all weekend is to get **that person** to say
**that word** in normal conversation. When they do, you shout "gotcha", report
it, someone confirms it — and you **inherit their mission**: their target and
their word become yours. Last player standing wins.

Nobody runs the game. The bot does. **Including you** — you're playing too, and
there is deliberately no screen anywhere in this project that shows you who
hunts whom.

---

## The one guarantee that matters

The targets form **one single loop** through all 16 players:

```
Ana → Ben → Cleo → … → Pia → Ana
```

This is the whole ballgame. If you assign targets with an ordinary random
shuffle you can accidentally get **several small loops** — say Ana↔Ben and
Cleo↔Dev. The moment Ana eliminates Ben she inherits Ben's mission, which is
"hunt Ana". She's now hunting herself while Cleo and Dev are still playing: the
game is stuck with no winner, and you find out on Saturday night.

One single loop makes that impossible. Every elimination splices one person out
of the loop and leaves a *smaller single loop*, so "my new target is me" can only
ever happen when the loop is down to **one person** — which isn't a bug, it's the
win. So: no dead ends, exactly one winner, guaranteed, for any number of players
from 2 up.

The code that does this is [`gotcha/assignments.py`](gotcha/assignments.py) and
it's the most heavily commented file in the project.

---

## What you need

* A computer that can stay on for the weekend (laptop is fine).
* **Python 3.10 or newer.** Check with `python3 --version`.
* Telegram on your phone.
* No server, no port forwarding, no public IP, no cloud account.

Install the libraries once:

```bash
cd gotcha
pip3 install -r requirements.txt
```

If `pip3` isn't found, try `python3 -m pip install -r requirements.txt`.

---

## What's in the folder

```
gotcha/
├── gotcha/                  the actual program
│   ├── assignments.py       ← the maths: the single loop + the word shuffle
│   ├── models.py            the shapes of things (a player, a mission, a report)
│   ├── storage.py           saving to the gotcha.db file (all the SQL lives here)
│   ├── engine.py            ← every rule of the game, in one place
│   ├── telegram_bot.py      the Telegram interface
│   └── webapp.py            the website interface
├── simulate.py              plays a whole fake game so you can watch it work
├── run_bot.py               starts the Telegram bot
├── run_web.py               starts the website
├── tests/                   automated checks
└── requirements.txt         the libraries to install
```

The important idea: **`engine.py` is the game.** Telegram and the website are
just two doors into the same room. They share one database file, so a player on
the website and a player on Telegram are in the same game and can gotcha each
other. Neither door can bend the rules, because neither door contains any.

---

## Step 0 — prove it works before you trust it

**Watch a whole game play itself:**

```bash
python3 simulate.py
```

You'll see 16 fake players, 15 eliminations, one winner:

```
16 players joined. Missions generated and DM'd privately.
Chain check: single loop through all 16 players ✔

--- play ---
 1. 💀 Ana is out! (15 left)   (confirmed by Ben)
 2. 💀 Iris is out! (14 left)   (confirmed by Mina)
 ...
15. 💀 Gus is out! (1 left)   (confirmed by Liam)

--- result ---
Elimination order: Ana → Iris → Dev → Hana → …  → Gus
🏆 Winner: Otto
Players: 16 | eliminations: 15 | survivors: 1
```

Note that even the simulator refuses to print the assignment map — it prints the
*shape* of the chain, not who had whom.

**Not convinced by one game? Play a thousand:**

```bash
python3 simulate.py --players 16 --repeat 1000 --quiet
```

```
1000 game(s) of 16 players: 1000 finished with exactly one winner, 0 dead ends.
```

After every single confirmation the simulator re-checks that the survivors are
still one unbroken loop, and it stops with a loud `BROKEN:` message if they
aren't. A thousand clean games means the maths holds.

**Run the automated tests:**

```bash
python3 -m pytest -q
```

Expect `141 passed`. The three checks you specifically asked for are:

| Where | What it proves |
|---|---|
| `tests/test_assignments.py::test_targets_form_a_single_cycle` | targets are one single loop, for every player count **2 to 30**, 200 fresh draws each |
| `tests/test_assignments.py::test_words_are_always_a_derangement` | every player gets exactly one word and **never their own** |
| `tests/test_full_game.py` | a full simulated game **always** ends with exactly one winner (including 200 back-to-back 16-player games) |

---

## Step 1 — get a Telegram bot token

A "bot token" is a long password that lets this program act as a Telegram
account. Getting one takes about two minutes and is free.

1. Open Telegram, search for **`@BotFather`** (the one with the blue check), open
   the chat and press **Start**.
2. Send `/newbot`.
3. It asks for a **name** — the display name. Type anything: `Gotcha Weekend`.
4. It asks for a **username** — must be unique and end in `bot`, e.g.
   `gotcha_lakehouse_bot`.
5. BotFather replies with a line like:
   `123456789:AAHk9x_ThIsIsThEtOkEnYoUwAnT-abcdef`
   **That's the token.** Treat it like a password — anyone with it controls your
   bot. Don't paste it into the group chat.
6. **Give players a command menu** (strongly recommended — it means nobody has
   to remember commands). Send `/setcommands` to BotFather, pick your bot, then
   paste this block exactly as-is:

   ```
   join - Join the game
   word - Submit or change your secret word
   mission - Show my current target and word
   gotcha - Claim you got your target to say your word
   confirm - Witness someone else's claim
   withdraw - Take back a claim I just made
   status - Who is still alive, and the kill feed
   players - Who has joined
   help - How this game works
   ```

   Admin commands are deliberately left out of the menu — they still work, they
   just don't advertise themselves to all 16 players.

7. Optional: `/setdescription` in BotFather, e.g. *"Word-assassin game. Send
   /join to play."*

### What else to set up on the Telegram side (and what to leave alone)

Almost nothing. This bot is `@gotchabitch_bot`, and out of the box BotFather's
defaults are already right for it.

**Do:**

* Paste the `/setcommands` block above, so players get a tappable command menu.
* Add the bot to your group chat as an **ordinary member** — it does not need to be
  an admin. (Only exception: if the group is set so that only admins can post,
  then it needs admin rights to announce eliminations.)
* Make sure each player **opens a private chat with the bot and presses Start**
  (sending `/join` does it). Telegram forbids a bot from messaging someone who has
  never messaged it first — this is the one thing that will bite you, and it's the
  usual reason `/begin` reports somebody unreachable.

**Leave alone — the defaults are what you want:**

* **Group Privacy: ON** (BotFather → Bot Settings → Group Privacy). With it on, the
  bot only receives *commands* in the group, not everyone's chatter — which is both
  more private and all it needs, since `/setfeed` is the only command it ever reads
  there. Don't turn it off.
* **Allow Groups: ON** (the default) — otherwise you can't add it to the group.
* **Inline mode, payments, web app, domain: off/unset.** None are used.
* **No webhook, no URL, no `/setwebhook`.** The bot long-polls, so there is nothing
  to point at your machine.

If several bots are in the same group, players should write `/setfeed@gotchabitch_bot`
so Telegram knows which bot is being addressed. Everything else happens in DMs
where there's no ambiguity.

---

## Step 2 — run the bot

In a terminal, in the `gotcha` folder:

```bash
export GOTCHA_BOT_TOKEN='123456789:AAHk9x_paste-your-real-token-here'
python3 run_bot.py
```

You should see `Gotcha bot starting (db=gotcha.db, admins=unclaimed)`. Leave this
terminal window open all weekend. That's it — the bot is live.

**Line by line, what those two commands mean:**

* `export GOTCHA_BOT_TOKEN='…'` — hands the token to the program without writing
  it into any file. You need to do this again each time you open a new terminal.
* `python3 run_bot.py` — starts the bot. It "long-polls": it repeatedly phones
  Telegram to ask if anyone messaged it. Telegram never has to reach *in* to your
  machine, which is why this works from home with no router configuration.

**Make yourself the admin.** In Telegram, message your bot privately and send
`/claimadmin`. First person to send it becomes admin, so do it before you tell
anyone else the bot exists. (Prefer belt and braces? Send `/whoami`, then restart
the bot with `export GOTCHA_ADMIN_IDS='your-number-from-whoami'`.)

**Stopping and restarting.** `Ctrl-C` stops it. The game lives in the file
`gotcha.db` next to the scripts, so starting it again continues exactly where you
left off — missions, eliminations and all. Don't delete that file mid-game.

---

## Step 3 — run the weekend

**Before people arrive**

1. Make a group chat with all 16 players, and add your bot to it.
2. In the group, send `/setfeed`. Announcements (eliminations, the winner) will
   now be posted there. Missions are *never* posted there.
3. Paste the player instructions (below) into the group.

**As people join**

Each player messages the bot **privately**, sends `/join`, then sends their word
as the next message. Check progress any time with `/lobby`:

```
Lobby - 14/16 ready
Joined: Ana, Ben, Cleo, …
No word yet: Otto, Pia
You cannot see anyone's word or assignment - not even as admin.
```

Chasing a no-show: `/kick Otto` removes them (only before the game starts).

**Start the game**

Send `/begin` privately to the bot. It builds the loop, checks it, and DMs all 16
players their first mission. You get your own mission in a DM like everyone else,
and a confirmation like:

```
Missions generated and DM'd to 16 players. ✅
I do not know what to tell you about the assignments, and neither does any
screen. Good luck.
```

> Telegram reserves `/start` for "say hello to a bot", so the game is started
> with **`/begin`** (`/startgame` and `/go` also work).

If something looked wrong — someone's phone was off, you started too early —
`/reroll` regenerates and re-sends everything. It's refused once the first
elimination has happened, because re-rolling mid-game would break the chain.

**During the weekend, everything runs itself**

* Someone gets their target to say the word → they send `/gotcha Ben`.
* Every other player gets a DM: *"Ana claims Ben said pineapple. Send /confirm."*
* Any other player (Ben included, and eliminated players too) sends `/confirm`
  and taps the button.
* The group chat gets `💀 Ben is out! (15 left)`, Ben gets a "you're out" DM, and
  Ana privately gets Ben's old target and word as her new mission.
* When two players are left and one gets the other, the bot announces the winner
  and the game ends.

You never adjudicate anything. Your only job is playing.

---

## Player instructions — paste this into the group chat

> **Gotcha rules**
> 1. DM **`@gotchabitch_bot`** privately and send `/join`, then send **one word**
>    — something people could plausibly say, but wouldn't say every hour
>    ("pineapple" ✅, "the" ❌). Nobody ever sees your word, including the organiser.
> 2. When the game starts you'll get a DM: **a target** and **a word**. Get your
>    target to say your word in normal conversation. Trickery encouraged, showing
>    them the word or asking them to say it is not.
> 3. Got them? DM the bot `/gotcha TheirName`.
> 4. Someone else then DMs the bot `/confirm` and taps the button. You can't
>    confirm your own.
> 5. Confirmed → they're out, and **you inherit their mission**. New target, new
>    word, same weekend. Keep hunting.
> 6. Last player standing wins.
>
> Useful commands, all in a DM with the bot: `/mission` (what am I doing again?),
> `/status` (who's still alive), `/confirm`, `/withdraw` (take back a claim you
> made by mistake), `/help`.

---

## Command reference

**Players (private chat with the bot)**

| Command | What it does |
|---|---|
| `/join` | join the game (use `/join Nickname` to set a different display name) |
| `/word pineapple` | submit or change your word (until the game starts) |
| `/mission` | re-check your current target and word |
| `/gotcha Ben` | claim you got your target to say your word |
| `/withdraw` | cancel a claim you just made |
| `/confirm` | witness someone else's claim |
| `/status` | who's alive, the kill feed |
| `/players` | who's joined |
| `/mylink` | your private web page link (only if the website is running) |
| `/help` | the rules and this list |

**Admin (also just a private chat with the bot)**

| Command | What it does |
|---|---|
| `/claimadmin` | become the admin (first come, first served) |
| `/lobby` | join progress — names only |
| `/kick Otto` | remove a no-show, before the start |
| `/begin` | generate the chain, DM everyone their mission |
| `/reroll` | regenerate and re-DM (refused after the first elimination) |
| `/setfeed` | run in the **group** so announcements go there |
| `/newgame Round 2` | start a fresh game |
| `/whoami` | show your Telegram user id |

There is no admin command that shows the assignments. It isn't hidden behind a
flag; it doesn't exist.

---

## The website (optional)

Same game, same database — a version for anyone who'd rather not use Telegram,
plus a public feed you can put on a TV.

```bash
export GOTCHA_ADMIN_KEY='pick-any-long-random-string'
python3 run_web.py
```

```
  Gotcha web app
  public feed : http://localhost:8000/
  admin page  : http://localhost:8000/admin?key=pick-any-long-random-string
```

Three kinds of page:

* **`/`** — public feed: who's alive, the eliminations. No assignments, ever.
* **`/p/<long-random-token>`** — one player's private page. This is a **magic
  link**: no password, holding the link *is* being that player. On the admin page
  press "Create an invite link" once per player and send each link to that person
  privately (DM, not the group). They open it, enter their name and word, and
  later the same link shows their mission and their gotcha button.
* **`/admin?key=…`** — join progress, kick, start. Public information only.

**Putting it online.** The bot needs nothing, but the website needs a public
address for people to reach it from their phones. Two easy options, neither
requiring you to touch your router:

* **Cloudflare Tunnel** (free, more stable — best if the URL should survive the
  weekend):
  ```bash
  # install once: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
  cloudflared tunnel --url http://localhost:8000
  ```
  It prints a `https://something-random.trycloudflare.com` URL. Use that.

* **ngrok** (quickest):
  ```bash
  ngrok http 8000
  ```
  Also prints an `https://…` URL.

Then tell the two programs what that public address is, so the links they hand
out are clickable from phones:

```bash
export GOTCHA_WEB_BASE='https://something-random.trycloudflare.com'
```

Restart both after setting it. Now `/mylink` in Telegram gives a player their own
web page too.

**If your players are on Telegram, start the game from Telegram.** Only the bot
can push a DM. If you press "Generate & send" on the website instead, Telegram
players won't get a ping — they just send `/mission` to see it. Same for
confirmations made on the website: they're valid, and the announcement will show
up in `/status` rather than as a push. Telegram is the primary interface; the
website is a bonus.

**Run both at once** by giving them the same database, in two terminals:

```bash
GOTCHA_DB=gotcha.db python3 run_bot.py     # terminal 1
GOTCHA_DB=gotcha.db python3 run_web.py     # terminal 2
```

---

## All the settings

Every setting is an environment variable — a value you `export` before starting.
All are optional except the bot token.

| Variable | Used by | Meaning |
|---|---|---|
| `GOTCHA_BOT_TOKEN` | bot | **required** — from BotFather |
| `GOTCHA_ADMIN_IDS` | bot | your Telegram user id (comma-separated for several admins). Skip it and use `/claimadmin` |
| `GOTCHA_DB` | both | database file, default `gotcha.db` |
| `GOTCHA_GAME_NAME` | both | name shown on pages, default `Gotcha` |
| `GOTCHA_ADMIN_KEY` | web | password in the admin URL. Random each start if unset |
| `GOTCHA_WEB_PORT` | web | port, default `8000` |
| `GOTCHA_WEB_HOST` | web | interface to listen on, default `0.0.0.0` |
| `GOTCHA_WEB_BASE` | both | your public URL, so generated links are clickable |

---

## How the guts work (the two tricky bits, in words)

### The single loop — Sattolo's algorithm

`gotcha/assignments.py` → `sattolo_cycle()`

Shuffling a list normally (Fisher–Yates, what `random.shuffle` does) walks the
list from the end and swaps each item with a random item **at or before** it.
"At" is the problem: an item can stay put, which is how you get people hunting
themselves and how you get several separate loops.

Sattolo's algorithm changes exactly one character: it swaps each item with a
random item **strictly before** it. Every item is therefore guaranteed to move,
and the mathematical consequence is that the result is **always** a single loop
through everything — and every possible such loop is equally likely, so it's
still properly random. One character; the entire dead-end class of bug gone.

In the code that difference is this line, with a comment telling future-you not
to "fix" it:

```python
j = rng.randrange(i)          # 0 ≤ j < i  — strictly less than i
```

The words are dealt separately, because they don't need loop structure — they
just need to be a *derangement*: everybody gets exactly one word, nobody gets
their own. (Judged by the text, so if two people submit "banana" neither of them
receives "banana".) A word that more than half the players submitted makes this
impossible, so the program refuses with a clear message and asks someone to
change theirs.

Then, before a single message goes out, `verify_assignments()` re-checks
everything: no self-targets, one single loop, no own words. It runs twice — once
on the freshly generated assignment and once again on what came back *out of the
database* — so a saving bug can't slip a broken chain into play either. If any
check fails, the game refuses to start rather than starting broken.

### Inheritance — how one elimination keeps the loop whole

`gotcha/engine.py` → `confirm_gotcha()`

When a gotcha is confirmed, the hunter takes over the victim's **entire** mission
— the victim's target *and* the victim's word:

```
before:   hunter → victim → next
after:    hunter → next            (victim spliced out)
```

That's why the loop can never fragment: cutting one link out of a loop leaves a
loop. It shrinks by one each time, until it's a loop of one person — the hunter
inherits *themselves* — and that's the win condition, handled explicitly in the
same function.

The engine also refuses to be gamed:

* You can only report on your **current** target. Naming anyone else is rejected
  (and deliberately doesn't tell you who your target is, so nobody can fish for
  other people's assignments by guessing).
* The reporter **cannot** confirm their own claim. Anyone else can — including
  the victim, and including already-eliminated players, since being out doesn't
  stop you having witnessed something.
* Duplicate reports and duplicate confirmations do nothing the second time.
  Nobody can be eliminated twice; two people tapping "confirm" at the same
  moment is fine.
* A claim that's gone stale (its hunter has since inherited a new target) is
  voided rather than honoured.
* A mission that couldn't be delivered is never swallowed: `/begin` names
  everyone it couldn't reach, and if an *inherited* mission fails to send, the
  bot says so publicly and tells that player to come and get it with
  `/mission`.

---

### Why the bot sends HTML, not Markdown

Telegram parses formatting *before* delivering a message, and rejects a message
whose markup doesn't parse. A player called `john_gelb` or a word like `*moist*`
dropped raw into a Markdown message makes it unparseable — so Telegram refuses it
and **the mission DM is never delivered**. That's the worst failure this game can
have: someone sitting there all Saturday with no mission.

So every message goes out as HTML with all player-supplied text escaped
(`gotcha/telegram_bot.py` → `esc()`), which is unambiguous and total. The test
suite validates *every single message* the bot builds against Telegram's HTML
rules as it is sent, and specifically replays a list of hostile names and words
(`john_gelb`, `Tom & Jerry`, `<b>Ana</b>`, `[link](http://x)`, …) through a whole
game. It also checks the escaping stops a player from choosing a name that
injects formatting into everyone else's messages.

If you edit the bot: **wrap every name, word and engine message in `esc()`.**

## Secrecy: what this protects, and what it doesn't

**What's enforced by the product:**

* Words and missions are only ever delivered privately — Telegram DM, or one
  player's own magic-link page.
* There is no admin screen, command, or URL that reveals who hunts whom or who
  holds which word. The engine has no method that returns the whole map; the one
  function that *builds* it (`generate_assignments`) hands the missions straight
  to the delivery loop and drops them. A test
  (`test_engine_has_no_method_that_returns_the_whole_map`) fails if anyone ever
  adds one.
* Admin views show public information only: who's joined, who's ready, who's
  alive, the elimination count, the feed.
* Assignments are never written to the log. The bot logs "player 7 submitted a
  word", never the word.
* Secret-bearing commands refuse to answer in a group chat.
* Web pages are sent with `Cache-Control: no-store` and `Referrer-Policy:
  no-referrer` so magic links don't leak through caches or referrer headers.

**The honest caveat:** the missions are stored in `gotcha.db` as plain text.
Whoever controls the machine can open that file with any SQLite tool and read
everything. That's you. So the residual trust is exactly: *"the organiser doesn't
open the database file."* Nothing in software can fix that while the same machine
also has to referee the game — see below. Two practical consequences:

* Keep `gotcha.db` on your own machine. Don't host it, don't sync it to a shared
  Dropbox, don't commit it (`.gitignore` already excludes it).
* If you use the tunnel, remember the *website* is public but the *database file*
  is not served by it — no page reads raw rows.

**Could we blind even the operator?** Partly, and it's worth knowing where the
wall is. You could encrypt each mission with a key only that player holds (say, a
passphrase they set at join time, or a keypair in their browser), so the stored
rows are unreadable without them. But the server has to *check* things: that the
person you reported is really your current target, that inheritance passes the
right target and word along. Those checks need the plaintext. You'd end up
either:

* keeping targets in the clear and encrypting only the words — modest gain, since
  the chain is the interesting secret; or
* moving verification to the players (everyone confirms cryptographically that a
  claim was valid), which is a genuinely different and much larger project.

For a 16-person weekend where you're not going to peek, plaintext plus "no screen
shows it" is the right trade, so that's what this does. It's a deliberate choice,
not an oversight.

---

## When something goes wrong

**"No bot token"** — you didn't run the `export GOTCHA_BOT_TOKEN=…` line in *this*
terminal window. Every new window needs it again.

**A player doesn't get their mission DM.** Telegram won't let a bot message
someone who has never messaged it. They must DM the bot `/start` (or `/join`)
first. `/begin` tells you exactly who it couldn't reach; have them message the
bot, then send `/reroll`.

**"Cannot start: Still waiting on a word from: Otto, Pia"** — exactly what it
says. Chase them, or `/kick` them.

**"Too many players submitted the same word"** — more than half the group picked
the same word, so somebody would have to be handed their own. Ask one of them to
`/word` something else.

**A name or word with punctuation in it** — fine. Underscores, asterisks,
ampersands, angle brackets, emoji: `moist_boy`, `Tom & Jerry`, `*shrug*` all work
and arrive looking exactly as typed. (Words are capped at 40 characters and 3
words; longer submissions get a polite refusal rather than being silently cut.)

**Someone reported the wrong person** — `/withdraw`, then report again.

**A claim is stuck waiting** — anyone other than the reporter can `/confirm` it;
the reporter can `/withdraw` it. Nothing else in the game is blocked meanwhile.

**Someone lost their web link** — they can DM the bot `/mylink` if they also
joined on Telegram. Otherwise, and only in the lobby, kick them and issue a new
invite. There's no way to look up an existing player's link from the admin page
by design — that link would let you read their mission.

**The bot crashed / the laptop rebooted.** Just start it again:
`python3 run_bot.py`. Nothing is lost; the game is in `gotcha.db`.

**You want to start over.** `/newgame Round 2` in Telegram makes a fresh game and
everyone re-joins. (Deleting `gotcha.db` also works, but destroys the history.)

---

## Running the checks after any change

```bash
python3 -m pytest -q                                  # all 141 tests
python3 simulate.py --players 16 --repeat 1000 --quiet # 1000 full games
```

If either complains, don't run the weekend on it.
