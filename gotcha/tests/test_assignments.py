"""Tests for the maths: single-cycle targets and derangement words."""

import random
from collections import Counter

import pytest

from gotcha.assignments import (
    AssignmentError,
    build_target_cycle,
    build_word_derangement,
    is_derangement,
    is_single_cycle,
    sattolo_cycle,
    verify_assignments,
)


# --- requirement 1: targets always form a single cycle, N = 2..30 ----------


@pytest.mark.parametrize("n", range(2, 31))
def test_targets_form_a_single_cycle(n):
    rng = random.Random(n)
    for trial in range(200):  # many draws per size, since the bug is random
        ids = [f"p{i}" for i in range(n)]
        targets = build_target_cycle(ids, rng)
        assert len(targets) == n
        assert set(targets) == set(ids)
        assert set(targets.values()) == set(ids), "someone is hunted twice / not at all"
        assert all(pid != tid for pid, tid in targets.items()), "self-target"
        assert is_single_cycle(targets), f"n={n} trial={trial} produced multiple loops"


def test_sattolo_never_leaves_an_element_in_place():
    rng = random.Random(7)
    for n in range(2, 25):
        for _ in range(100):
            original = list(range(n))
            shuffled = sattolo_cycle(original, rng)
            assert original == list(range(n)), "input must not be mutated"
            assert sorted(shuffled) == original
            assert all(shuffled[i] != i for i in range(n))


def test_sattolo_reaches_every_possible_cycle():
    """For n=4 there are (n-1)! = 6 single cycles; all should show up."""
    rng = random.Random(11)
    seen = set()
    for _ in range(4000):
        targets = build_target_cycle([0, 1, 2, 3], rng)
        assert is_single_cycle(targets)
        seen.add(tuple(sorted(targets.items())))
    assert len(seen) == 6


def test_is_single_cycle_rejects_two_small_loops():
    """The exact bug we are guarding against: A<->B plus C<->D."""
    two_loops = {"A": "B", "B": "A", "C": "D", "D": "C"}
    assert not is_single_cycle(two_loops)
    assert is_single_cycle({"A": "B", "B": "C", "C": "D", "D": "A"})
    # A lone self-hunt IS a single (1-)cycle mathematically - that is exactly the
    # end state of a won game. It is rejected as a *starting* assignment instead,
    # by build_target_cycle (see test_single_player_game_is_refused).
    assert is_single_cycle({"A": "A"})
    assert not is_single_cycle({})


def test_single_player_game_is_refused():
    with pytest.raises(AssignmentError):
        build_target_cycle(["solo"], random.Random(0))


# --- requirement 2: words are always a valid derangement -------------------


@pytest.mark.parametrize("n", range(2, 31))
def test_words_are_always_a_derangement(n):
    rng = random.Random(1000 + n)
    for _ in range(50):
        ids = list(range(n))
        own = {i: f"word{i}" for i in ids}
        assigned = build_word_derangement(ids, own, rng)
        assert set(assigned) == set(ids)
        assert Counter(assigned.values()) == Counter(own.values()), "words must be dealt 1:1"
        assert is_derangement(own, assigned)


def test_duplicate_words_are_still_deranged_by_text():
    """Two people submitting 'banana' must not receive 'banana' back."""
    rng = random.Random(3)
    ids = list(range(8))
    own = {0: "banana", 1: "Banana", 2: "  banana ", 3: "cat", 4: "dog", 5: "emu", 6: "fig", 7: "gnu"}
    for _ in range(100):
        assigned = build_word_derangement(ids, own, rng)
        assert is_derangement(own, assigned)


def test_words_deranged_when_exactly_half_are_identical():
    """The hardest feasible case: n/2 duplicates. Exercises the fallback path."""
    rng = random.Random(5)
    n = 16
    ids = list(range(n))
    own = {i: ("moist" if i < n // 2 else f"word{i}") for i in ids}
    for _ in range(50):
        assigned = build_word_derangement(ids, own, rng)
        assert is_derangement(own, assigned)


def test_too_many_duplicate_words_fails_loudly():
    ids = list(range(6))
    own = {i: ("moist" if i < 4 else f"word{i}") for i in ids}
    with pytest.raises(AssignmentError, match="same word"):
        build_word_derangement(ids, own, random.Random(0))


def test_missing_word_fails_loudly():
    with pytest.raises(AssignmentError, match="not submitted"):
        build_word_derangement([1, 2], {1: "cat", 2: "  "}, random.Random(0))


# --- the guardrail --------------------------------------------------------


def test_verify_rejects_multiple_cycles():
    targets = {1: 2, 2: 1, 3: 4, 4: 3}
    own = {1: "a", 2: "b", 3: "c", 4: "d"}
    words = {1: "b", 2: "c", 3: "d", 4: "a"}
    with pytest.raises(AssignmentError, match="single cycle"):
        verify_assignments(targets, own, words)


def test_verify_rejects_self_target():
    targets = {1: 1, 2: 3, 3: 2}
    own = {1: "a", 2: "b", 3: "c"}
    words = {1: "b", 2: "c", 3: "a"}
    with pytest.raises(AssignmentError, match="themselves"):
        verify_assignments(targets, own, words)


def test_verify_rejects_own_word():
    targets = {1: 2, 2: 3, 3: 1}
    own = {1: "a", 2: "b", 3: "c"}
    words = {1: "A", 2: "c", 3: "b"}  # player 1 got their own word back
    with pytest.raises(AssignmentError, match="derangement"):
        verify_assignments(targets, own, words)


def test_verify_accepts_a_good_assignment():
    rng = random.Random(42)
    ids = list(range(16))
    own = {i: f"word{i}" for i in ids}
    targets = build_target_cycle(ids, rng)
    words = build_word_derangement(ids, own, rng)
    verify_assignments(targets, own, words)  # must not raise
