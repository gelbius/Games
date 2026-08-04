# Games
Games for the love of fun

## [Gotcha](gotcha/) 🎯

A self-administering word-assassin game for a long weekend. Everyone submits one
secret word and gets a secret mission — a person, plus a word to make them say.
Get them to say it, report it, inherit their mission, keep hunting; last player
standing wins.

Runs as a Telegram bot (no port forwarding needed) and/or a small web app, both on
one shared game engine. The target assignments form a single Hamiltonian cycle
(Sattolo's algorithm), which is what guarantees no dead ends and exactly one
winner. Full instructions, written for non-coders:
[gotcha/README.md](gotcha/README.md).
