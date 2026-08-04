import random
import sys
from pathlib import Path

import pytest

# Let `pytest` be run from anywhere: make the project root importable.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gotcha.engine import GotchaEngine  # noqa: E402
from gotcha.storage import Storage  # noqa: E402

WORDS = [
    "pineapple", "hydrangea", "kerfuffle", "bamboozle", "penguin", "aubergine",
    "trombone", "wombat", "spatula", "cardigan", "meringue", "flamingo",
    "gazebo", "yoghurt", "kayak", "tapioca", "walrus", "clementine",
    "harmonica", "pumpernickel", "sassafras", "zeppelin", "quokka", "linoleum",
    "marzipan", "narwhal", "obelisk", "paprika", "rutabaga", "semaphore",
    "tambourine", "wisteria",
]


@pytest.fixture()
def engine():
    storage = Storage(":memory:")
    yield GotchaEngine(storage)
    storage.close()


@pytest.fixture()
def rng():
    return random.Random(1234)


def seed_lobby(engine, n, with_words=True, game_name="Test game"):
    """Create a game with `n` joined players (and optionally their words)."""
    game = engine.create_game(game_name)
    players = []
    for i in range(n):
        player = engine.add_player(game.id, name=f"P{i:02d}", telegram_id=500 + i)
        if with_words:
            engine.submit_word(player.id, WORDS[i % len(WORDS)] + ("" if i < len(WORDS) else str(i)))
        players.append(player)
    return game, players
