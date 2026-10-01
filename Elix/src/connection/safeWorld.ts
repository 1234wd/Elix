/**
 * Safe world helpers — never crash on unknown blocks/entities.
 *
 * blockName(block) / entityName(entity) return "unknown_solid" /
 * "unknown_entity" for IDs missing from the registry (log each ID once).
 * Later phases must use these helpers.
 */

const loggedUnknownBlockIds = new Set<number>();
const loggedUnknownEntityIds = new Set<number>();

/**
 * Get a block's name, or "unknown_solid" if not in the registry.
 * Logs each unknown ID once.
 */
export function blockName(block: { name?: string; id?: number } | null | undefined): string {
  if (!block) return "unknown_solid";
  if (block.name) return block.name;
  if (block.id !== undefined && !loggedUnknownBlockIds.has(block.id)) {
    loggedUnknownBlockIds.add(block.id);
    console.warn(`[safeWorld] unknown block ID ${block.id} — treating as unknown_solid`);
  }
  return "unknown_solid";
}

/**
 * Get an entity's name, or "unknown_entity" if not in the registry.
 * Logs each unknown ID once.
 */
export function entityName(entity: { name?: string; type?: number; entityType?: number } | null | undefined): string {
  if (!entity) return "unknown_entity";
  if (entity.name) return entity.name;
  const id = entity.type ?? entity.entityType;
  if (id !== undefined && !loggedUnknownEntityIds.has(id)) {
    loggedUnknownEntityIds.add(id);
    console.warn(`[safeWorld] unknown entity ID ${id} — treating as unknown_entity`);
  }
  return "unknown_entity";
}
