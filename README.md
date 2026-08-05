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

## [Creature Derby](creature-derby/) 🐛

Eight procedurally generated 3D animals race for fifteen seconds. You pick the
two you like, they breed, and their children race. Over a dozen generations the
creatures start to look like whatever you have been choosing for.

There is no fitness function — you are the selection pressure. That is the whole
design, and it is also why it runs in a browser tab: only ever eight creatures
are simulated, instead of the thousands an automatic search would need. Every
creature's entire genome fits in a URL, so sharing one needs no server and no
account.

A homage to Karl Sims' 1994 paper *Evolving Virtual Creatures*. Built with
three.js and Rapier. Instructions, written for non-coders:
[creature-derby/README.md](creature-derby/README.md).
