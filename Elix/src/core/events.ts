import { EventEmitter } from "node:events";
import type { ElixConfig } from "./config.js";
import type { DisconnectKind } from "../connection/reconnect.js";

/**
 * Typed event bus — the only channel between Elix's four mind layers
 * (reflex / skill / planner / social). The LLM never touches mineflayer
 * directly; it emits validated actions here.
 *
 * Later layers listen to this bus; they never reach into the bot.
 */
export interface ElixEvents {
  "config:loaded": (config: ElixConfig) => void;
  /** Bot spawned and is playable. */
  "bot:joined": (info: {
    username: string;
    host: string;
    port: number;
    version: string;
    protocol: number;
    serverBrand: string;
  }) => void;
  /** Any in-game chat message from another player (untrusted input). */
  "bot:chat": (msg: { username: string; text: string }) => void;
  /** Server kicked us; the socket has not necessarily closed yet. */
  "bot:kicked": (info: { kind: DisconnectKind; text: string; translateKey?: string }) => void;
  /** Socket closed. `kind` is the classified reason; permanent ones don't retry. */
  "bot:left": (info: { kind: DisconnectKind; reason: string; willRetry: boolean }) => void;
  /** Reconnect scheduled. */
  "bot:reconnecting": (info: { attempt: number; delayMs: number }) => void;
  "shutdown": (reason: string) => void;
}

type Handler<T> = T extends (...args: infer A) => void ? (...args: A) => void : never;

class TypedBus {
  private readonly em = new EventEmitter();
  /** Original handler → wrapper, so `off` removes the exact wrapper we added. */
  private readonly wrappers = new Map<
    keyof ElixEvents,
    Map<(...args: never[]) => void, (...args: unknown[]) => void>
  >();

  on<K extends keyof ElixEvents>(event: K, fn: Handler<ElixEvents[K]>): void {
    // A listener throwing must never take down the game loop.
    const wrapped = (...args: unknown[]) => {
      try {
        (fn as (...a: unknown[]) => void)(...args);
      } catch (err) {
        console.error(`[bus] listener for "${String(event)}" threw: ${(err as Error).message}`);
      }
    };
    let forEvent = this.wrappers.get(event);
    if (!forEvent) {
      forEvent = new Map();
      this.wrappers.set(event, forEvent);
    }
    forEvent.set(fn as (...args: never[]) => void, wrapped);
    this.em.on(event, wrapped);
  }

  off<K extends keyof ElixEvents>(event: K, fn: Handler<ElixEvents[K]>): void {
    const wrapped = this.wrappers.get(event)?.get(fn as (...args: never[]) => void);
    if (wrapped) {
      this.em.off(event, wrapped);
      this.wrappers.get(event)?.delete(fn as (...args: never[]) => void);
      return;
    }
    this.em.off(event, fn as unknown as (...args: unknown[]) => void);
  }

  emit<K extends keyof ElixEvents>(event: K, ...args: Parameters<ElixEvents[K]>): void {
    this.em.emit(event, ...args);
  }

  /** Test helper: drop every listener. */
  removeAll(): void {
    this.em.removeAllListeners();
    this.wrappers.clear();
  }

  listenerCount(event: keyof ElixEvents): number {
    return this.em.listenerCount(event);
  }
}

export const bus = new TypedBus();