"""The maths of the game. Pure functions: no database, no network, no interface.

Two independent things get generated when a game starts:

1. THE TARGET CHAIN — who hunts whom.
   This *must* be one single loop through every player:
       P1 -> P2 -> P3 -> ... -> Pn -> P1
   See `build_target_cycle` for why, at length.

2. THE WORD ASSIGNMENT — which submitted word each player must extract.
   Everybody gets exactly one word, subject to two bans:
     * never your OWN word;
     * never your TARGET's own word — being told to make Mignon say the very
       word Mignon submitted is a free kill, and it tells you something about
       her you were not meant to know.
   Words carry no loop structure; they ride along with the mission and get
   inherited together with the target.
"""

from __future__ import annotations

import random
from collections import Counter
from typing import Dict, Hashable, List, Optional, Sequence, TypeVar

T = TypeVar("T", bound=Hashable)


class AssignmentError(Exception):
    """Raised when assignments cannot be built, or fail their safety checks.

    This is deliberately loud: we would rather refuse to start the game than
    deliver a broken chain that dead-ends halfway through the weekend.
    """


class NoLegalWordDeal(AssignmentError):
    """No way to deal the words that satisfies both bans *for this chain*.

    Worth its own type because it depends on the target cycle we happened to
    draw, not only on the words: whether a word can be dealt depends on who is
    hunting whom. The engine reacts by drawing a fresh chain and trying again,
    and only gives up if the words are hopeless whatever the chain.
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


def _forbidden_texts(
    player_ids: Sequence[T],
    own_words: Dict[T, str],
    targets: Optional[Dict[T, T]],
) -> Dict[T, set]:
    """Which word *texts* each player must not be given.

    Always their own. Also their target's, except in a 2-player game where that
    is impossible - the only two words in existence are those two, so the rule
    is dropped rather than making the game unstartable. By then the endgame has
    arrived anyway and the words in play were inherited long ago.
    """
    banned = {pid: {_norm(own_words[pid])} for pid in player_ids}
    if targets and len(player_ids) >= 3:
        for pid in player_ids:
            banned[pid].add(_norm(own_words[targets[pid]]))
    return banned


def _match_words_to_players(
    player_ids: Sequence[T],
    words: List[str],
    banned: Dict[T, set],
    rng: random.Random,
) -> Optional[Dict[T, str]]:
    """Find one legal deal, or None if no legal deal exists.

    A straight augmenting-path matching over "which of the n word slips may this
    player be handed". Random shuffling keeps successive games from looking
    alike; the matching itself guarantees we only give up when the deal really
    is impossible, rather than when we were unlucky.
    """
    allowed = {
        pid: [k for k in range(len(words)) if _norm(words[k]) not in banned[pid]]
        for pid in player_ids
    }
    for slips in allowed.values():
        rng.shuffle(slips)
    order = list(player_ids)
    rng.shuffle(order)

    holder: Dict[int, T] = {}  # word slip -> the player holding it

    def assign(pid: T, tried: set) -> bool:
        for slip in allowed[pid]:
            if slip in tried:
                continue
            tried.add(slip)
            if slip not in holder or assign(holder[slip], tried):
                holder[slip] = pid
                return True
        return False

    for pid in order:
        if not assign(pid, set()):
            return None
    return {pid: words[slip] for slip, pid in holder.items()}


def build_word_derangement(
    player_ids: Sequence[T],
    own_words: Dict[T, str],
    rng: random.Random,
    targets: Optional[Dict[T, T]] = None,
) -> Dict[T, str]:
    """Deal the submitted words out under both bans (see `_forbidden_texts`).

    Words are compared by text, not by who typed them: if Ana and Ben both
    submitted "banana", handing Ana Ben's copy would still feel like getting her
    own word back, and would still be a free kill against Ben.

    Pass `targets` to enforce the second ban. Without it only the own-word ban
    applies, which is all the maths needs — the target ban is a playability rule.
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

    banned = _forbidden_texts(ids, own_words, targets)

    # Fast path: shuffle the pile and check. Usually succeeds within a few tries.
    for _ in range(500):
        shuffled = words[:]
        rng.shuffle(shuffled)
        if all(_norm(shuffled[k]) not in banned[ids[k]] for k in range(n)):
            return dict(zip(ids, shuffled))

    # Slow path: solve it properly rather than keep rolling dice.
    matched = _match_words_to_players(ids, words, banned, rng)
    if matched is None:
        raise NoLegalWordDeal(
            f"No way to deal these words without giving somebody their own word or "
            f"their target's. Too many players chose {hottest!r} ({hottest_count} of "
            f"{n}) - with this rule a word can be shared by at most about a third of "
            "the group. Ask one of them to pick something else, then start again."
        )
    return matched


def is_derangement(own_words: Dict[T, str], assigned: Dict[T, str]) -> bool:
    """True if every player has exactly one word and it is not their own."""
    if set(own_words) != set(assigned):
        return False
    return all(_norm(assigned[pid]) != _norm(own_words[pid]) for pid in own_words)


def nobody_hunts_their_targets_own_word(
    targets: Dict[T, T],
    own_words: Dict[T, str],
    assigned: Dict[T, str],
) -> bool:
    """True if no player was told to extract the word their target submitted."""
    if len(targets) < 3:  # impossible to satisfy with 2 players; see _forbidden_texts
        return True
    return all(
        _norm(assigned[pid]) != _norm(own_words[targets[pid]]) for pid in targets
    )


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
    if not nobody_hunts_their_targets_own_word(targets, own_words, assigned_words):
        raise AssignmentError(
            "Somebody was told to make their target say that target's own word - "
            "a free kill, and a leak. Refusing to start."
        )
