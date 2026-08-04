"""Gotcha — a self-administering word-assassin game.

The package is split so that the game rules live in exactly one place:

    assignments.py  pure maths: the single-cycle target chain + word derangement
    models.py       plain data containers passed between layers
    storage.py      SQLite persistence (the only module that knows SQL)
    engine.py       the game engine: every rule, every state transition
    telegram_bot.py interface #1 (long polling, no inbound ports needed)
    webapp.py       interface #2 (magic links, admin status, public feed)

Interfaces never re-implement rules; they only call the engine.
"""

from .engine import (
    AssignmentError,
    GotchaError,
    GotchaEngine,
    RuleViolation,
)

__all__ = ["GotchaEngine", "GotchaError", "RuleViolation", "AssignmentError"]
