/**
 * Numeric block ids, from the ONE vendored data accessor.
 *
 * `bot.findBlocks` wants an id or a predicate, and the id has to be the one the SERVER uses -
 * which is the connected version's, not a number typed into this file. So both directions go
 * through `src/world/mcdata.ts`, and a block Elix has never heard of simply has no id, which
 * the gather rules treat as "not gatherable" rather than as zero.
 */
import { dataForVersion } from "./mcdata.js";

/** The block's name for a numeric id, or null. */
export function blockNameOf(id: number): string | null {
  const data = dataForVersion();
  if (data === null) return null;
  const block = data.blocksByName;
  for (const name of Object.keys(block)) {
    if ((block[name] as { id?: unknown } | undefined)?.id === id) return name;
  }
  return null;
}

/** The block's numeric id for a name, or null. */
export function blockIdOf(name: string): number | null {
  const def = dataForVersion()?.blocksByName?.[name] as { id?: unknown } | undefined;
  return typeof def?.id === "number" ? def.id : null;
}
