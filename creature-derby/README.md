# Creature Derby 🐛

Eight strange little animals race across flat ground for fifteen seconds. You
pick the two you like best. They breed. Their eight children race. Repeat.

Nothing in this game decides which creature is *good*. There is no score, no
target, no clever algorithm judging the winner. You are the one doing the
choosing, and over a dozen generations the creatures start to look like whatever
it is you have been picking for.

It is a homage to Karl Sims' 1994 paper *Evolving Virtual Creatures* — see
[CREDITS.md](CREDITS.md).

---

## Playing it

| What you do | What happens |
| --- | --- |
| Watch | Eight creatures race. The number in each corner is how far it has got. |
| Click two panels | They light up as **parent A** and **parent B**. |
| Press **Breed the next generation** | Those two carry over untouched, and six children join them. |
| Drag the **mutation** slider | From `clones` to `feral`, how different the children are. |
| Press **Lineage** | The family tree of where this generation came from. |
| Press **Share** | Copies a link to the creature you picked first. |

Keyboard, if you prefer: **1**–**8** pick creatures, **Enter** breeds them,
**R** replays the race, **Ctrl/⌘+N** starts over with eight new strangers.

### A few things worth knowing

**Creatures that fall over have not failed.** Many of the fastest ones never
stand up at all — they flop, roll, or worm along. Whether that is charming or
annoying is entirely your call, which is the point.

**Pick for one thing at a time.** Choosing "the two that went furthest" every
round gets dull fast. Try picking the two with the most legs, or the two that
look most like a crab, and watch a body plan take over.

**Turn the mutation slider down when you find something good.** On `subtle`,
children are near-copies and a lineage refines slowly. On `feral`, you will lose
whatever you had, but you will see things you would never have found otherwise.

**Every creature fits in a link.** The Share button copies a URL containing that
creature's entire genome — every body part, every joint, every wiggle. No
account, no server, nothing stored anywhere. Send it to someone and they get
that exact animal, plus seven variations to breed from.

**The same creature always races the same way.** The physics runs on a fixed
clock with a seeded random number generator, so a shared link replays exactly
what the sender saw, on any machine.

---

## Running it on your own computer

You will need [Node.js](https://nodejs.org/) version 20 or newer. Everything
below is typed into a terminal.

### Getting the code

If you have never cloned this repository before:

```bash
git clone https://github.com/gelbius/Games.git
cd Games
```

If you already have it, make sure it is up to date:

```bash
cd ~/Games      # wherever you keep it
git pull
```

**If `creature-derby` does not exist yet**, the game is still on a branch that
has not been merged. Fetch it and switch to it:

```bash
git fetch origin
git checkout claude/creature-derby-game-9s85ns
```

Switching branches swaps the files in the folder, which is why `creature-derby`
appears and disappears. Nothing is lost either way — `git checkout main` puts it
back the way it was.

### Starting it

```bash
cd creature-derby
npm install     # once, to fetch the libraries
npm run dev     # start it up
```

That prints a web address — usually <http://localhost:5173>. Open it in a
browser.

To stop it, press **Ctrl+C** in the terminal.

> **`cd: no such file or directory: creature-derby`** means you are in the wrong
> folder, or the branch above has not been checked out. Run `pwd` to see where
> you are: you want to be in `Games`, not in `Games/gotcha`.

> **`Could not read package.json`** means the same thing — `npm` was run
> somewhere that has no Node project in it.

### The other commands

```bash
npm run build      # make the deployable version, in dist/
npm run preview    # check that built version locally
npm test           # run the tests
npm run typecheck  # check the code for mistakes without running it
```

---

## Putting it on the internet (Cloudflare Pages)

The built game is just static files — no server, no database — so hosting it is
free and simple.

**1. Push this repository to GitHub**, if it is not there already.

**2. Go to the Cloudflare dashboard** at <https://dash.cloudflare.com>, and
choose **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.

**3. Pick this repository**, then enter these build settings *exactly*:

| Setting | Value |
| --- | --- |
| Framework preset | `None` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | `creature-derby` |

The **root directory** is the one people miss. This repository holds more than
one game, so Cloudflare has to be told which folder to build.

**4. Press Save and Deploy.** A couple of minutes later you will have a URL like
`creature-derby.pages.dev`. Every push to your default branch redeploys it.

**5. Stop it rebuilding for the other games.** By default Cloudflare redeploys
on *every* push to the repository — including pushes that only touched Gotcha
and cannot possibly have changed this game. Harmless, but noisy, and it burns
build minutes.

In your new Pages project, go to **Settings → Builds & deployments → Build watch
paths**, and set:

| Field | Value |
| --- | --- |
| Include paths | `creature-derby/*` |

Builds now only trigger when this folder actually changes. Cloudflare
occasionally moves this setting around the dashboard; if you cannot find it,
search their docs for "build watch paths".

### If the build fails

There is nothing else to configure — no environment variables, no secrets, no
database. The log will almost always point at one of two things:

- **"root directory"** — step 3 above was missed or misspelled.
- **Node version** — Cloudflare's default is usually fine, but you can pin it by
  adding an environment variable `NODE_VERSION` set to `20`.

---

## How it works, briefly

Roughly in the order things happen:

| File | What it does |
| --- | --- |
| [`src/genome/types.ts`](src/genome/types.ts) | What a creature *is*: a small graph of body parts and joints |
| [`src/genome/random.ts`](src/genome/random.ts) | Inventing a creature from a single number |
| [`src/genome/codec.ts`](src/genome/codec.ts) | Squeezing a creature into a link, and back out safely |
| [`src/genome/expand.ts`](src/genome/expand.ts) | Growing a body from the graph, including mirroring limbs |
| [`src/genome/breed.ts`](src/genome/breed.ts) | Crossover and mutation |
| [`src/sim/creature.ts`](src/sim/creature.ts) | Making it physical, and wiggling the joints |
| [`src/render/broadcastCamera.ts`](src/render/broadcastCamera.ts) | Keeping a lurching creature in frame |
| [`src/race/`](src/race/) | Eight independent worlds, one canvas |
| [`src/ui/`](src/ui/) | Picking, sharing, and the family tree |

The `tools/` folder holds development instruments rather than game code — they
measure how far creatures travel, sweep physics settings, check the camera never
loses its subject, and drive the interface in a real browser. Several decisions
in this project were made by running those and reading the numbers, and a few
were reversed by them.

## Licence

MIT. See [`../LICENSE`](../LICENSE).
