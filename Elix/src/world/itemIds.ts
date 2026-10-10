/**
 * Numeric ITEM ids, from the ONE vendored data accessor.
 *
 * `bot.recipesFor` and `bot.craft` want a numeric item id, and it has to be the one the
 * CONNECTED version uses. So both directions go through `src/world/mcdata.ts`; an item Elix has
 * never heard of simply has no id, which the craft rules treat as "not craftable" rather than
 * as zero - a zero id is a real block in the protocol.
 */
import { allItems, dataForVersion } from "./mcdata.js";

/** The item's numeric id for a name, or null. */
export function itemIdOf(name: string): number | null {
  const def = dataForVersion()?.itemsByName?.[name] as { id?: unknown } | undefined;
  return typeof def?.id === "number" ? def.id : null;
}

/** The item's name for a numeric id, or null. */
export function itemNameOf(id: number): string | null {
  for (const item of allItems()) {
    if (item.id === id) return item.name;
  }
  return null;
}
