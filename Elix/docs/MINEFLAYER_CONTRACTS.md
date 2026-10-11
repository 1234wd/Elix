# Mineflayer contracts

Every API Elix depends on, and what it actually does. Each line is checked against the
**installed** mineflayer in `tests/unit/mineflayerContracts.test.ts`, so if a version bump changes
one of these, the build fails here rather than in a game.

Source paths are relative to the installed package (`node_modules/mineflayer/`).

---

## Searching the world

| API | Contract | Evidence |
|---|---|---|
| `bot.findBlocks(opts)` | Returns **Vec3 COORDINATES**, not Block objects. `docs/api.md`: "the found block coordinates (not the blocks)". | `docs/api.md` §`bot.findBlocks` |
| `bot.findBlock(opts)` | Returns a **Block** (or `null`). | `docs/api.md` §`bot.findBlock` |
| Consequence | Anything handed to `openContainer`, `dig` or `placeBlock` must be a Block. A Vec3 fails **silently or with an opaque error**. Turn coordinates into blocks with `bot.blockAt(pos)`. | `docs/api.md` §`bot.openContainer`: "The block instance to open" |

## Containers and placement

| API | Contract | Evidence |
|---|---|---|
| `bot.openContainer(blockOrEntity)` | Needs a **Block or an Entity**. | `lib/plugins/chest.js` → `async function openContainer(containerToOpen, direction, cursorPos)` |
| `window.deposit(itemType, metadata, count, nbt)` | Four arguments; `nbt` optional. | `docs/api.md` §`window.deposit` |
| `window.withdraw(...)` | Exists. **Elix never calls it.** | `docs/api.md` §`window.withdraw` |
| `bot.placeBlock(referenceBlock, faceVector)` | **Two** arguments and **no item**: it places whatever Elix is **holding**, against a reference block and a face. | `lib/plugins/place_block.js` → `async function placeBlock (referenceBlock, faceVector)`; the item comes from `bot.heldItem` in `lib/plugins/generic_place.js` |
| Consequence | Placing a block is **equip, then place**. Forgetting the equip is the "nothing happened" bug. | — |

## Digging

| API | Contract | Evidence |
|---|---|---|
| `bot.dig(block)` | Rejects on a null block; rejects when `digTime` is `Infinity`. | `lib/plugins/digging.js` |
| `bot.dig(block)` **while digging** | **Aborts the dig already in flight** ("Digging aborted"). | `lib/plugins/digging.js`: a new dig calls `stopDigging()` on the old one |
| Consequence | A tick that digs every 50 ms throws away its own work. One dig in flight at a time. | — |
| `bot.stopDigging()` | Aborts the dig in flight. This is how `elix stop` reaches a dig already swinging. | `lib/plugins/digging.js` |
| Consequence | Dig only from **within reach** — measured eye-to-block-centre, about 4.5–5 blocks. | — |

## Pathfinding

| API | Contract | Evidence |
|---|---|---|
| `pathfinder.setGoal(goal)` | **Resets the path and clears the control states** on every call. | `mineflayer-pathfinder/index.js`: `resetPath('goal_updated')`, `resetPath(reason, clearStates = true)` → `bot.clearControlStates()` |
| Consequence | Calling `setGoal` on a 50 ms tick means Elix **never takes a step**. Issue a goal when the target **changes**; re-issue a moving target only after it has moved more than 2 blocks. | — |
| `GoalNear(x, y, z, range)` | **Four numbers.** | `mineflayer-pathfinder/lib/goals.js` → `constructor (x, y, z, range)` |
| `GoalGetToBlock(x, y, z)` | **Three numbers**, each `Math.floor`ed. | `mineflayer-pathfinder/lib/goals.js` → `constructor (x, y, z)` |
| Consequence | Passing a position **object** gives NaN coordinates and a pathfinder that walks confidently in the wrong direction. | — |
| Arrival | Prefer the distance check on the tick over `goal_reached`, which only fires for goals Elix set. | — |

## Inventory

| API | Contract | Evidence |
|---|---|---|
| `bot.toss(itemType, metadata, count)` | Three arguments; `count` `null` means the whole stack. There is **no zero-count guard** of its own. | `lib/plugins/simple_inventory.js` → `async function toss (itemType, metadata, count)` |
| `bot.equip(item, destination)` | Reads `item.slot`; `destination` must be a real slot (`hand`, `head`, `torso`, `legs`, `feet`). Sets `bot.heldItem`. | `lib/plugins/simple_inventory.js` |
| Consequence | A fake that does not update `heldItem` makes the weapon reflex re-equip every tick. | — |

## Crafting

| API | Contract | Evidence |
|---|---|---|
| `bot.recipesFor(itemType, metadata, minResultCount, craftingTable)` | **Synchronous.** Returns an array. | `lib/plugins/craft.js` → `function recipesFor (...)` … `return results` |
| `bot.craft(recipe, count, craftingTable)` | **Throws** `Recipe requires craftingTable, but one was not supplied` when the recipe needs one and the argument is `null`. | `lib/plugins/craft.js` |
| Consequence | The `craftingTable` argument is the placed **Block**, not the item and not the coordinates. And the recipe must come from `bot.recipesFor` — minecraft-data's recipe is a different shape the real library rejects. | — |
| A 2×2 recipe | Fits the **inventory** grid, so it needs no table. `crafting_table` itself is one: four planks in a 2×2. | vendored 26.2 `recipes.json` |

## Living

| API | Contract | Evidence |
|---|---|---|
| `bot.health` | **0–20** | `lib/plugins/health.js` |
| `bot.food` | **0–20** | `lib/plugins/eating.js` |
| `bot.oxygenLevel` | **0–20** — `Math.round(air_supply / 15)`. NOT 0–300. | `lib/plugins/breath.js` |
| `entity.isInWater` | boolean | `docs/api.md` §`entity` |
| `bot.whisper(username, message)` | **Two** arguments; the recipient's exact username. | `docs/api.md` §`bot.whisper` |
| Consequence | Coordinates go to owners by whisper and never into public chat. | — |

## Data

| API | Contract | Evidence |
|---|---|---|
| `minecraft-data` `blocksByName` / `itemsByName` | Keyed by **name**; each entry has numeric `id`, `defaultState`, `hardness`, `material`. | vendored 26.2 |
| `minecraft-data` `recipes` | Keyed by **result numeric id**, several rows per key. | vendored 26.2 |
| `minecraft-data` `items` | Keyed by **numeric id**, not an array. | vendored 26.2 |
| `findBlocks({ matching })` | Accepts an id, an array of ids, or a predicate over **Block** objects. | `lib/plugins/blocks.js` |
