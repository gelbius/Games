"""Tests for the maths: single-cycle targets and derangement words."""

import random
from collections import Counter

import pytest

from gotcha.assignments import (
    AssignmentError,
    NoLegalWordDeal,
    build_target_cycle,
    build_word_derangement,
    is_derangement,
    is_single_cycle,
    nobody_hunts_their_targets_own_word,
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
    words = build_word_derangement(ids, own, rng, targets=targets)
    verify_assignments(targets, own, words)  # must not raise


# --- requirement 3: never your target's own word ---------------------------


@pytest.mark.parametrize("n", range(3, 31))
def test_nobody_is_sent_to_extract_their_targets_own_word(n):
    """The mission "make Mignon say the word Mignon chose" is a free kill."""
    rng = random.Random(500 + n)
    for _ in range(50):
        ids = list(range(n))
        own = {i: f"word{i}" for i in ids}
        targets = build_target_cycle(ids, rng)
        assigned = build_word_derangement(ids, own, rng, targets=targets)
        assert is_derangement(own, assigned)
        assert nobody_hunts_their_targets_own_word(targets, own, assigned)
        verify_assignments(targets, own, assigned)


def test_the_rule_holds_with_duplicate_words():
    """Judged by text, so a duplicate of the target's word is banned too."""
    rng = random.Random(9)
    ids = list(range(10))
    own = {0: "banana", 1: "BANANA", 2: " banana ", 3: "cat", 4: "cat",
           5: "dog", 6: "emu", 7: "fig", 8: "gnu", 9: "hen"}
    for _ in range(60):
        targets = build_target_cycle(ids, rng)
        assigned = build_word_derangement(ids, own, rng, targets=targets)
        assert is_derangement(own, assigned)
        assert nobody_hunts_their_targets_own_word(targets, own, assigned)


def test_a_quarter_of_the_group_sharing_a_word_still_works():
    """Luck runs out here, so the matching has to do the work."""
    rng = random.Random(11)
    n = 16
    ids = list(range(n))
    own = {i: ("moist" if i < 4 else f"word{i}") for i in ids}
    solved = 0
    for _ in range(30):
        targets = build_target_cycle(ids, rng)
        try:
            assigned = build_word_derangement(ids, own, rng, targets=targets)
        except NoLegalWordDeal:
            continue  # this particular chain has no deal; the engine redraws
        verify_assignments(targets, own, assigned)
        solved += 1
    assert solved > 20, "a quarter-share should almost always be dealable"


def test_half_the_group_sharing_a_word_is_now_impossible():
    """An honest consequence of the new rule, reported in plain language.

    A word owned by m players cannot go to those m, nor to anyone hunting one
    of them - so roughly a third of the group is the ceiling, not a half.
    """
    rng = random.Random(12)
    n = 16
    ids = list(range(n))
    own = {i: ("moist" if i < n // 2 else f"word{i}") for i in ids}
    targets = build_target_cycle(ids, rng)
    with pytest.raises(NoLegalWordDeal, match="at most about a third"):
        build_word_derangement(ids, own, rng, targets=targets)


def test_two_players_are_exempt_because_it_is_impossible():
    """With 2 players the only two words are both banned - the rule is dropped."""
    rng = random.Random(3)
    ids = [0, 1]
    own = {0: "alpha", 1: "beta"}
    targets = build_target_cycle(ids, rng)
    assigned = build_word_derangement(ids, own, rng, targets=targets)
    assert assigned == {0: "beta", 1: "alpha"}
    verify_assignments(targets, own, assigned)  # must not raise


def test_three_players_is_the_tightest_solvable_case():
    rng = random.Random(4)
    ids = [0, 1, 2]
    own = {0: "alpha", 1: "beta", 2: "gamma"}
    for _ in range(30):
        targets = build_target_cycle(ids, rng)
        assigned = build_word_derangement(ids, own, rng, targets=targets)
        verify_assignments(targets, own, assigned)


def test_verify_rejects_a_targets_own_word():
    targets = {1: 2, 2: 3, 3: 1}
    own = {1: "a", 2: "b", 3: "c"}
    words = {1: "B", 2: "c", 3: "a"}  # player 1 must make player 2 say "b"
    with pytest.raises(AssignmentError, match="target's own word"):
        verify_assignments(targets, own, words)


def test_impossible_word_sets_fail_with_an_explanation():
    """Every word the same: no legal deal exists, and we say so clearly."""
    ids = list(range(4))
    own = {i: "moist" for i in ids}
    with pytest.raises(AssignmentError, match="same word"):
        build_word_derangement(ids, own, random.Random(0), targets={0: 1, 1: 2, 2: 3, 3: 0})
