/**
 * The memory CLI (D8).
 *
 *   elix memory search "<q>"   top 10 with their score breakdown
 *   elix memory stats          counts per table, unembedded, last backup,
 *                              last consolidation
 *   elix forget --player <n>   y/N confirmation, --yes for scripts
 */
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore, defaultMemoryPath } from "../memory/store.js";
import { Memory } from "../memory/retrieval.js";
import { listBackups, purgePlayerFromBackups, KEEP_BACKUPS } from "../memory/backup.js";
import { PROJECT_ROOT } from "../core/config.js";

function openStore(): MemoryStore {
  const store = new MemoryStore({ path: defaultMemoryPath(PROJECT_ROOT) });
  // Vectors are optional; retrieval degrades to FTS5 without them.
  store.loadVec();
  return store;
}

async function runForget(opts: { player: string; yes?: boolean }): Promise<void> {
  const player = opts.player;
  const store = openStore();
  try {
    const before = store.stats();
    const backups = listBackups(join(PROJECT_ROOT, "data", "backups"));

    if (!opts.yes) {
      console.log(`This permanently deletes everything Elix remembers about "${player}":`);
      console.log(`  ${before.episodes} episodes, ${before.facts} facts, ${before.promises} promises.`);
      console.log(`  Also purged from ${backups.length} backup file(s).`);
      console.log("");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question(`Really delete ${player}'s data? [y/N] `)).trim().toLowerCase();
      rl.close();
      if (answer !== "y" && answer !== "yes") {
        console.log("Nothing deleted.");
        return;
      }
    }

    const removed = store.forgetPlayer(player);
    const purge = purgePlayerFromBackups(join(PROJECT_ROOT, "data", "backups"), player);

    console.log(`Deleted for "${player}":`);
    console.log(`  episodes  ${removed.episodes ?? 0}   (vectors ${removed.vectors ?? 0})`);
    console.log(`  facts     ${removed.facts ?? 0}`);
    console.log(`  promises  ${removed.promises ?? 0}`);
    console.log(`  profile   removed`);
    if (purge.scanned > 0) {
      console.log("");
      console.log(`  Purged from ${purge.scanned} backup(s) (${purge.purged} episode rows).`);
    }
    if (backups.length > 0) {
      console.log(
        `  Oldest backup expires in about ${backups.length} day(s) at the current keep policy.`,
      );
    }
  } finally {
    store.close();
  }
}

export function registerMemoryCommands(program: Command): void {
  // ONE parent command. Commander refuses a second top-level `memory`
  // ("cannot add command 'memory' as already have command 'memory'"), so every
  // subcommand hangs off this single instance.
  const memory = program
    .command("memory")
    .description("Search and inspect what Elix remembers");

  memory
    .command("search")
    .argument("<query>", "what to look for")
    .description("Search remembered episodes and facts")
    .option("--player <name>", "restrict to one player")
    .option("--limit <n>", "how many results", (v) => Number.parseInt(v, 10))
    .action((query: string, opts: { player?: string; limit?: number }) => {
      const store = openStore();
      try {
        const memory = new Memory(store);
        const results = memory.search(query, null, {
          limit: opts.limit ?? 10,
          ...(opts.player ? { player: opts.player } : {}),
        });
        if (results.length === 0) {
          console.log(`No memories match "${query}".`);
          return;
        }
        console.log(`${results.length} result(s) for "${query}":\n`);
        results.forEach((r, i) => {
          const p = r.parts;
          const when = new Date(r.episode.ts).toISOString().slice(0, 16).replace("T", " ");
          const who = r.episode.player ?? r.episode.speaker;
          console.log(`${i + 1}. score ${r.score.toFixed(4)}  [${r.source}]  ${when}  ${who}`);
          console.log(`   ${r.episode.text}`);
          console.log(
            `   cosine ${p.cosine.toFixed(3)}  bm25 ${p.bm25.toFixed(3)}  ` +
              `recency ${p.recency.toFixed(3)}  importance ${p.importance.toFixed(3)}  ` +
              `relationship ${p.relationship.toFixed(3)}`,
          );
          console.log("");
        });
      } finally {
        store.close();
      }
    });

  memory
    .command("stats")
    .description("Counts, unembedded rows, last backup and last consolidation")
    .action(() => {
      const store = openStore();
      try {
        const s = store.stats();
        const backups = listBackups(join(PROJECT_ROOT, "data", "backups"));
        const lastConsolidation = store.lastConsolidation();
        const dbPath = defaultMemoryPath(PROJECT_ROOT);

        console.log("Elix memory");
        console.log(`  database:      ${dbPath}${existsSync(dbPath) ? "" : "  (not created yet)"}`);
        console.log(`  vectors:       ${store.hasVectors ? "loaded" : "not available — FTS5 keyword search only"}`);
        console.log("");
        console.log("  counts");
        for (const [k, v] of Object.entries(s)) {
          console.log(`    ${k.padEnd(16)} ${v}`);
        }
        console.log("");
        console.log("  embeddings");
        console.log(`    unembedded    ${s.unembedded ?? 0}`);
        if (s.unembedded && !store.hasVectors) {
          console.log("    (no vector store loaded, so nothing can be embedded right now)");
        }
        console.log("");
        console.log("  backups");
        if (backups.length === 0) {
          console.log("    (none yet — one is written on shutdown and each in-game night)");
        } else {
          const last = backups[backups.length - 1]!;
          console.log(`    kept          ${backups.length} of max ${KEEP_BACKUPS}`);
          console.log(`    last          ${last.name}  (${last.bytes} bytes)`);
        }
        console.log("");
        console.log("  consolidation");
        if (!lastConsolidation) {
          console.log("    (none yet — runs each in-game night and on shutdown)");
        } else {
          console.log(
            `    last          ${new Date(lastConsolidation.ts).toISOString()}  status ${lastConsolidation.status}`,
          );
          console.log(
            `    episodes      ${lastConsolidation.episodes}   facts made ${lastConsolidation.factsMade}`,
          );
        }
        console.log("");
        console.log("  mood (Phase 5 drives this)");
        const mood = store.mood();
        console.log(
          `    ${mood.mood}  valence ${mood.valence.toFixed(2)}  arousal ${mood.arousal.toFixed(2)}  dominance ${mood.dominance.toFixed(2)}`,
        );
      } finally {
        store.close();
      }
    });

  memory
    .command("forget")
    .description("Delete a player's data on request")
    .requiredOption("--player <name>", "player whose data to delete")
    .option("--yes", "skip the confirmation prompt")
    .action(runForget);

  // The vision's CLI is `elix forget --player <name>`, so keep a top-level
  // alias. A10: `requiredOption` is the correct form — a plain
  // `.option("--player")` makes commander reject the value as unknown.
  //
  // Both entry points share ONE implementation. Duplicating the delete logic
  // would mean two places that must both remember to purge the backups.
  program
    .command("forget")
    .description("Delete a player's data on request (alias for `elix memory forget`)")
    .requiredOption("--player <name>", "player whose data to delete")
    .option("--yes", "skip the confirmation prompt")
    .action(runForget);
}
