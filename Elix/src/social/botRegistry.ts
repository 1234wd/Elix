/**
 * Bot registry — lets say.ts find the current bot instance without
 * circular imports. bot.ts registers the bot here on creation.
 */

let currentBot: import("mineflayer").Bot | null = null;

export function setBot(bot: import("mineflayer").Bot | null): void {
  currentBot = bot;
}

export function getBot(): import("mineflayer").Bot | null {
  return currentBot;
}
