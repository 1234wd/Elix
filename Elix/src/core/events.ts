import { EventEmitter } from "node:events";
import type { ElixConfig } from "./config.js";

/**
 * Typed event bus — the only channel between Elix's four mind layers
 * (reflex / skill / planner / social). The LLM never touches mineflayer
 * directly; it emits validated actions here.
 *
 * Phase 1 defines the foundational events; later phases extend ElixEvents.
 */
export interface ElixEvents {
  "config:loaded": (config: ElixConfig) => void;
  "bot:joined": (info: { username: string; host: string; port: number }) => void;
  "bot:chat": (msg: { username: string; text: string }) => void;
  "bot:left": (reason: string) => void;
  "shutdown": (reason: string) => void;
}

type Handler<T> = T extends (...args: infer A) => void ? (...args: A) => void : never;

class TypedBus {
  private readonly em = new EventEmitter();

  on<K extends keyof ElixEvents>(event: K, fn: Handler<ElixEvents[K]>): void {
    this.em.on(event, fn);
  }

  off<K extends keyof ElixEvents>(event: K, fn: Handler<ElixEvents[K]>): void {
    this.em.off(event, fn);
  }

  emit<K extends keyof ElixEvents>(event: K, ...args: Parameters<ElixEvents[K]>): void {
    this.em.emit(event, ...args);
  }
}

export const bus = new TypedBus();
