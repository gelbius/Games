"""The maths of the game. Pure functions: no database, no network, no interface.

Two independent things get generated when a game starts:

1. THE TARGET CHAIN — who hunts whom.
   This *must* be one single loop through every player:
       P1 -> P2 -> P3 -> ... -> Pn -> P1
   See `build_target_cycle` for why, at length.

2. THE WORD ASSIGNMENT — which submitted word each player must extract.
   This only has to be a "derangement": everybody gets exactly one word and
   nobody gets their own. Words do not need any loop structure; they just ride
   along with the mission and get inherited together with the target.
"""

from __future__ import annotations

import random
from collections import Counter
from typing import Dict, Hashable, List, Sequence, TypeVar

T = TypeVar("T", bound=Hashable)


class AssignmentError(Exception):
    """Raised when assignments cannot be built, or fail their safety checks.

    This is deliberately loud: we would rather refuse to start the game than
    deliver a broken chain that dead-ends halfway through the weekend.
    """


# ---------------------------------------------------------------------------
# 1. Targets: a single Hamiltonian cycle via Sattolo's algorithm
# ---------------------------------------------------------------------------


def sattolo_cycle(items: Sequence[T], rng: random.Random) -> List[T]:
    """Return a shuffled copy of `items` that is a uniformly random *single cycle*.

    HOW IT DIFFERS FROM A NORMAL SHUFFLE
    ------------------------------------
    Fisher-Yates (a.k.a. `random.shuffle`) picks `j` from `0..i` *inclusive*,
    so an element is allowed to stay where it is. That produces any of the n!
    permutations - including ones that break this game:

      * a permutation with a fixed point  -> someone hunts themselves on day 1;
      * a permutation with several cycles -> e.g. {A->B, B->A} and {C->D, D->C}.
        The moment A eliminates B, A inherits B's mission, which is "hunt A".
        A is now hunting themselves while C and D are still playing: the game
        has dead-ended with no winner. This is THE bug this whole file exists
        to prevent.

    Sattolo's algorithm changes exactly one character: `j` is drawn from
    `0..i-1` (strictly below `i`), so every element is *guaranteed* to move.
    The result is always a permutation consisting of one cycle of length n, and
    every one of the (n-1)! such cycles is equally likely. That is precisely
    "one big loop through everybody, chosen uniformly at random".

    WHY ONE BIG LOOP MAKES THE GAME SAFE
    ------------------------------------
    With a single cycle of length n, eliminating a player splices them out of
    the loop, leaving a single cycle of length n-1. By induction the chain stays
    one loop forever, so "my new target is myself" can only happen when the loop
    has length 1 - i.e. when only one player is left. That event is not a bug,
    it *is* the win condition.
    """
    pool = list(items)
    # Walk from the last index down to index 1.
    for i in range(len(pool) - 1, 0, -1):
        # rng.randrange(i) yields 0 <= j <= i-1: strictly less than i.
        # THIS is the difference from Fisher-Yates. Do not "fix" it to i + 1.
        j = rng.randrange(i)
        pool[i], pool[j] = pool[j], pool[i]
    return pool


def build_target_cycle(player_ids: Sequence[T], rng: random.Random) -> Dict[T, T]:
    """Map every player to the player they hunt, as one single cycle.

    Sattolo shuffles the *positions* 0..n-1; reading the shuffled array as the
    mapping `position i -> position perm[i]` gives a single n-cycle. We then
    translate positions back into player ids.
    """
    ids = list(player_ids)
    n = len(ids)
    if n < 2:
        raise AssignmentError("A game needs at least 2 players.")
    if len(set(ids)) != n:
        raise AssignmentError("Duplicate player ids were passed to the generator.")

    perm = sattolo_cycle(range(n), rng)
    return {ids[i]: ids[perm[i]] for i in range(n)}


def is_single_cycle(targets: Dict[T, T]) -> bool:
    """True if `targets` is one loop that visits every player exactly once."""
    n = len(targets)
    if n == 0:
        return False
    # Every player must appear exactly once as a hunter and once as a target.
    if set(targets) != set(targets.values()):
        return False
    if len(set(targets.values())) != n:
        return False

    # Walk the chain from an arbitrary start; a single cycle returns to the
    # start only after visiting all n players.
    start = next(iter(targets))
    seen = 0
    node = start
    while True:
        node = targets[node]
        seen += 1
        if node == start:
            return seen == n
        if seen > n:  # pragma: no cover - safety net against malformed input
            return False


# ---------------------------------------------------------------------------
# 2. Words: a derangement of the submitted words
# ---------------------------------------------------------------------------


def _norm(word: str) -> str:
    """Words are compared case/space-insensitively ('Pineapple' == 'pineapple')."""
    return " ".join(word.strip().lower().split())


def build_word_derangement(
    player_ids: Sequence[T],
    own_words: Dict[T, str],
    rng: random.Random,
) -> Dict[T, str]:
    """Deal the submitted words out so nobody receives their own word.

    "Own word" is judged by text, not by who typed it: if Ana and Ben both
    submitted "banana", handing Ana Ben's copy of "banana" would still feel like
    getting her own word back, so we forbid it.

    That means the deal is impossible when one word is too popular - if 9 of 16
    players submit "moist", at least one of them has to receive "moist". We
    detect that up front and say so clearly (someone just picks a new word).
    """
    ids = list(player_ids)
    n = len(ids)
    if n < 2:
        raise AssignmentError("A game needs at least 2 players.")
    missing = [i for i in ids if not (own_words.get(i) or "").strip()]
    if missing:
        raise AssignmentError(f"{len(missing)} player(s) have not submitted a word yet.")

    words = [own_words[i] for i in ids]
    counts = Counter(_norm(w) for w in words)
    hottest, hottest_count = counts.most_common(1)[0]
    if hottest_count > n // 2:
        raise AssignmentError(
            f"Too many players submitted the same word ({hottest!r}: {hottest_count} of {n}). "
            "At most half the players may share a word, otherwise somebody must "
            "be given their own word. Ask someone to change theirs."
        )

    # Fast path: shuffle the pile of words and check. For real games this
    # succeeds on the first or second try.
    for _ in range(500):
        shuffled = words[:]
        rng.shuffle(shuffled)
        if all(_norm(shuffled[k]) != _norm(words[k]) for k in range(n)):
            return dict(zip(ids, shuffled))

    # Slow path, guaranteed to work whenever the feasibility check above passed.
    # Group players by the word they submitted, biggest group first, then hand
    # out the words rotated by the size of the biggest group. A rotation of at
    # least the largest block length can never land a block back on itself.
    groups: Dict[str, List[int]] = {}
    for k, word in enumerate(words):
        groups.setdefault(_norm(word), []).append(k)
    ordered_groups = sorted(groups.values(), key=lambda g: (-len(g), rng.random()))
    for group in ordered_groups:
        rng.shuffle(group)

    order = [k for group in ordered_groups for k in group]
    shift = len(ordered_groups[0])
    result = {}
    for position, k in enumerate(order):
        donor = order[(position + shift) % n]
        result[ids[k]] = words[donor]
    if any(_norm(result[ids[k]]) == _norm(words[k]) for k in range(n)):  # pragma: no cover
        raise AssignmentError("Internal error: could not deal words without a self-match.")
    return result


def is_derangement(own_words: Dict[T, str], assigned: Dict[T, str]) -> bool:
    """True if every player has exactly one word and it is not their own."""
    if set(own_words) != set(assigned):
        return False
    return all(_norm(assigned[pid]) != _norm(own_words[pid]) for pid in own_words)


# ---------------------------------------------------------------------------
# 3. The guardrail that runs before anything is delivered
# ---------------------------------------------------------------------------


def verify_assignments(
    targets: Dict[T, T],
    own_words: Dict[T, str],
    assigned_words: Dict[T, str],
) -> None:
    """Abort loudly unless the assignment is safe to play.

    Called immediately after generation AND again after the rows are written to
    the database, so a persistence bug cannot slip a broken chain into play.
    """
    if set(targets) != set(own_words):
        raise AssignmentError("Target chain and word list cover different players.")
    if any(pid == tid for pid, tid in targets.items()):
        raise AssignmentError("Somebody was assigned themselves as a target.")
    if not is_single_cycle(targets):
        raise AssignmentError(
            "Target assignments do not form one single cycle through all players. "
            "Refusing to start: this is the dead-end bug."
        )
    if not is_derangement(own_words, assigned_words):
        raise AssignmentError(
            "Word assignment is not a valid derangement (somebody got their own word)."
        )
