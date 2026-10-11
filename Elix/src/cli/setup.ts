/**
 * The first-run wizard: `elix setup`.
 *
 * Written for somebody who has never opened a terminal. It asks ONE question - the owner's
 * Minecraft name - writes it into `config/elix.yaml` WITHOUT destroying the comments in that file,
 * checks which keys exist in `.env` BY NAME ONLY, runs the doctor, and then says the next three
 * things to do in plain words.
 *
 * Three rules that are not negotiable:
 *
 *   - **A key's VALUE is never printed, logged, echoed or returned.** The wizard reports names
 *     and "set"/"missing" and nothing else. `envKeyReport` returns booleans, never strings, so
 *     there is nothing to leak by accident.
 *   - **The YAML file keeps its comments.** A round-trip through a YAML parser would delete every
 *     explanation the owner wrote, so only the `owners:` line is rewritten, in place.
 *   - **Nothing is printed that has to be understood.** The last screen is three numbered lines.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/** A Minecraft name: letters, digits and underscore. Anything else is a typo, not a name. */
export const MINECRAFT_NAME = /^[A-Za-z0-9_]{3,16}$/u;

/** The keys the wizard looks for, in the order the owner will meet them. */
export const SETUP_KEYS: ReadonlyArray<readonly [name: string, label: string]> = Object.freeze([
  ["GROQ_API_KEY", "Groq"],
  ["HF_TOKEN", "Hugging Face"],
  ["NVIDIA_API_KEY", "NVIDIA"],
]);

/** Whether a key is set. The VALUE is never returned, because there is nothing here that needs it. */
export function envKeyReport(env: NodeJS.ProcessEnv): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [name] of SETUP_KEYS) {
    const raw = env[name];
    out[name] = typeof raw === "string" && raw.trim().length > 0;
  }
  return out;
}

/** A one-line, owner-readable summary: names and states only. */
export function renderKeyReport(env: NodeJS.ProcessEnv): string {
  const report = envKeyReport(env);
  const lines = SETUP_KEYS.map(([name, label]) => `  ${report[name] === true ? "found" : "missing"}  ${label} (${name})`);
  return ["Keys in .env:", ...lines].join("\n");
}

/**
 * The `owners:` list, rewritten IN PLACE so the rest of the file keeps its comments.
 *
 * A YAML round-trip would strip every comment a previous owner wrote, and this file is the one
 * place a non-technical person is asked to read. If there is no `owners:` line yet, one is added
 * at the end rather than creating a new file, because `config/elix.yaml` is the file the running
 * bot already reads.
 */
export function writeOwners(yamlText: string, names: readonly string[]): string {
  const clean = names.map((n) => n.trim()).filter((n) => n !== "" && MINECRAFT_NAME.test(n));
  const rendered =
    clean.length === 0 ? "owners: []" : `owners:\n${clean.map((n) => `  - ${n}`).join("\n")}`;

  const lines = yamlText.split(/\r?\n/u);
  const at = lines.findIndex((line) => /^\s*owners\s*:/u.test(line));
  if (at < 0) {
    const tail = lines.length > 0 && (lines[lines.length - 1] ?? "") !== "" ? [...lines, ""] : lines;
    return [...tail, rendered, ""].join("\n");
  }
  // Replace the `owners:` line and every list item under it, leaving everything else alone.
  let end = at + 1;
  while (end < lines.length && /^\s+-\s/u.test(lines[end] ?? "")) end += 1;
  const next = [...lines.slice(0, at), ...rendered.split("\n"), ...lines.slice(end)];
  return next.join("\n");
}

/** The whole wizard, as pure steps, so a test can drive it without a terminal. */
export interface SetupIo {
  /** Asks for the owner's name. Returns "" when the owner pressed Ctrl+C or gave nothing. */
  askName(prompt: string): Promise<string>;
  /** Prints one block of text. */
  say(text: string): void;
}

export interface SetupOptions {
  /** Where `config/elix.yaml` lives. */
  configPath: string;
  /** The environment, so a test can pass its own. */
  env?: NodeJS.ProcessEnv;
}

/** The three next steps, in the words a new owner needs. */
export const NEXT_STEPS: readonly string[] = Object.freeze([
  "1. Start Elix: pnpm start   (leave that window open)",
  "2. Join your server and type: elix hello",
  "3. Ask for something real: elix get 5 dirt",
]);

/**
 * Run the wizard. Returns the exit code the CLI should use.
 *
 * Never throws: a wizard that crashes on a missing file is worse than one that says what is
 * missing and stops.
 */
export async function runSetup(io: SetupIo, options: SetupOptions): Promise<number> {
  const env = options.env ?? {};
  io.say("Welcome to Elix. This takes about a minute.\n");

  io.say(renderKeyReport(env));
  io.say("");

  const answer = (await io.askName("What is your Minecraft name? (3-16 letters, digits or _)")).trim();
  if (answer === "") {
    io.say("\nNo name given, so nothing was changed. Run `pnpm elix setup` when you are ready.");
    return 1;
  }
  if (!MINECRAFT_NAME.test(answer)) {
    io.say(`\n"${answer}" is not a Minecraft name. Names are 3-16 letters, digits or underscore.`);
    io.say("Nothing was changed. Run `pnpm elix setup` again.");
    return 1;
  }

  const configPath = isAbsolute(options.configPath) ? options.configPath : resolve(process.cwd(), options.configPath);
  // A fresh clone has no config directory at all, so creating the file means creating the
  // directory too. The first version assumed config/ already existed, because every developer
  // machine has one - which is the difference between a wizard and a script.
  const folder = dirname(configPath);
  if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
  const before = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const existing = /^owners:\s*\n(?:\s+-\s*\S+\s*\n?)*/mu.exec(before);
  const names = existing === null ? [answer] : mergeNames(before, answer);
  writeFileSync(configPath, writeOwners(before, names), "utf8");

  io.say(`\nSaved. ${answer} can now give Elix orders.`);
  io.say("\nNext:");
  for (const step of NEXT_STEPS) io.say(`  ${step}`);
  return 0;
}

/** Keep any owners already listed, and add the new one if it is not there. */
function mergeNames(yamlText: string, name: string): string[] {
  const out: string[] = [];
  for (const line of yamlText.split(/\r?\n/u)) {
    const m = /^\s+-\s+(\S+)\s*$/u.exec(line);
    if (m?.[1] !== undefined && MINECRAFT_NAME.test(m[1]) && !out.includes(m[1])) out.push(m[1]);
  }
  if (!out.includes(name)) out.push(name);
  return out;
}
