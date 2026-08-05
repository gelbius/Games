# Credits

## The origin of the design

Creature Derby is a homage to:

> Karl Sims, **"Evolving Virtual Creatures"**.
> *SIGGRAPH '94: Proceedings of the 21st Annual Conference on Computer Graphics
> and Interactive Techniques*, July 1994, pages 15–22.
> <https://www.karlsims.com/evolved-virtual-creatures.html>

Essentially every interesting idea in this project came from that paper. In
particular:

- **The genome is a directed graph, not a tree.** Nodes are body parts, edges
  describe how a child part attaches to its parent. An edge may point back at
  its own node, and a per-node recursion limit bounds how many times that can
  happen — which is how one small gene grows a multi-segment limb or a tail.
  This lives in [`src/genome/types.ts`](src/genome/types.ts) and
  [`src/genome/expand.ts`](src/genome/expand.ts).

- **Reflection as a first-class part of the genome.** Sims' creatures carry a
  reflection flag on their connections, and it is the single biggest reason his
  creatures read as animals rather than as debris. It is a flag on every edge
  here too.

- **Growing a phenotype from a genome as a separate step** from evaluating it,
  so that the body plan and the controller are described by the same compact
  structure.

- **A companion paper** worth reading alongside it, on creatures evolved to
  compete rather than to move: Karl Sims, "Evolving 3D Morphology and Behavior
  by Competition", *Artificial Life IV*, 1994.

Sims' original work ran on a Connection Machine CM-5 and searched populations of
hundreds of creatures against an automatic fitness function. This project does
the opposite: it never searches at all. Eight creatures run, a human picks two,
and those two breed. That is the only difference that matters, and it is what
lets the whole thing sit in a browser tab.

## Reference implementation

An MIT-licensed reference implementation of Sims' creatures, noted here as
prior art and as a useful thing to read:

> <https://github.com/jjuiddong/KarlSims>

No code from that repository is used here — this implementation was written
from the paper's description and against a different stack (TypeScript,
three.js, Rapier rather than C++). It is credited because it is a genuinely
helpful reference for anyone trying to follow the same ideas.

## Where this deliberately differs from the paper

Being explicit about this, because the differences are choices rather than
oversights:

| Sims, 1994 | Creature Derby |
| --- | --- |
| Automatic fitness functions (speed, jumping, following) | The player is the entire fitness function; nothing is scored |
| Populations of ~300, evolved over ~100 generations | Eight creatures at a time, one generation per click |
| Neural-network controllers with sensors and effectors | Sinusoidal oscillators — three evolvable numbers per joint |
| Simulated in water and on land | Flat ground only |
| Reflection mirrors a subtree's coordinate frame | Reflection instantiates a mirrored *pair*, which is what actually produces bilateral symmetry |

The controller choice is the one most likely to be revisited. Sinusoids cannot
react to anything — a creature cannot feel the ground or notice it has fallen
over — but they produce convincing gaits, and when a creature behaves strangely
you can read off exactly why. Neural controllers are a natural version two.

## Software

- [three.js](https://threejs.org/) — rendering (MIT)
- [Rapier](https://rapier.rs/) — physics, Rust compiled to WebAssembly (Apache-2.0)
- [Vite](https://vite.dev/) — build tooling (MIT)
- [TypeScript](https://www.typescriptlang.org/) (Apache-2.0)
- [Playwright](https://playwright.dev/) — used only by the tools in `tools/` (Apache-2.0)

## Licence

Creature Derby is MIT licensed. See [`../LICENSE`](../LICENSE) at the root of
this repository for the full text.
