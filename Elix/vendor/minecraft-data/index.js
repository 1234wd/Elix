/**
 * Vendored minecraft-data wrapper.
 *
 * Adds Minecraft PC 26.2 (protocol 776) support from the community PR
 * PrismarineJS/minecraft-data#1298 (merged 2026-09-19, commit 68ea7b59).
 * The npm release 3.117.0 does not yet include 26.2, so we vendor the data
 * files here and wrap the real package.
 *
 * For 26.2: loads vendored JSON files, processes them through the same
 * mcDataToNode pipeline as the real package.
 * For all other versions: delegates to the real package.
 */

const base = require('minecraft-data-base')
const mcDataToNode = require('minecraft-data-base/lib/loader')
const supportFeature = require('minecraft-data-base/lib/supportsFeature')

// ---------------------------------------------------------------------------
// Load vendored 26.2 data
// ---------------------------------------------------------------------------

const data26_2 = {
  blocks: require('./data/pc/26.2/blocks.json'),
  items: require('./data/pc/26.2/items.json'),
  recipes: require('./data/pc/26.2/recipes.json'),
  entities: require('./data/pc/26.2/entities.json'),
  biomes: require('./data/pc/26.2/biomes.json'),
  protocol: require('./data/pc/26.2/protocol.json'),
  language: require('./data/pc/26.2/language.json'),
  version: require('./data/pc/26.2/version.json'),
  blockCollisionShapes: require('./data/pc/26.2/blockCollisionShapes.json'),
  blockLoot: require('./data/pc/26.2/blockLoot.json'),
  entityLoot: require('./data/pc/26.2/entityLoot.json'),
  foods: require('./data/pc/26.2/foods.json'),
  materials: require('./data/pc/26.2/materials.json'),
  particles: require('./data/pc/26.2/particles.json'),
  commands: require('./data/pc/26.2/commands.json'),
  loginPacket: require('./data/pc/26.2/loginPacket.json'),
  sounds: require('./data/pc/26.2/sounds.json'),
  tints: require('./data/pc/26.2/tints.json'),
  attributes: require('./data/pc/26.2/attributes.json'),
  // Borrowed from 26.1 (unchanged in 26.2 per PR #1298)
  effects: require('./data/pc/26.1/effects.json'),
  enchantments: require('./data/pc/26.1/enchantments.json'),
  instruments: require('./data/pc/26.1/instruments.json'),
  // From 1.20.3 (new file added in PR #1298)
  windows: require('./data/pc/1.20.3/windows.json')
}

// ---------------------------------------------------------------------------
// Process 26.2 data through the same pipeline as the real package
// ---------------------------------------------------------------------------

const nmcData = mcDataToNode(data26_2)
nmcData.type = 'pc'

// Build version comparison support
// Real dataVersion from protocolVersions.json at commit 68ea7b59
const dataVersions = {}
for (const v of base.versions.pc) {
  dataVersions[v.minecraftVersion] = v.dataVersion
}
const DATA_VERSION_26_2 = 4903
dataVersions['26.2'] = DATA_VERSION_26_2

const version26_2 = {
  version: 776,
  minecraftVersion: '26.2',
  majorVersion: '26.2',
  releaseType: 'release',
  dataVersion: DATA_VERSION_26_2,
  type: 'pc',
  '>=': (other) => DATA_VERSION_26_2 >= (dataVersions[other] ?? 0),
  '<': (other) => DATA_VERSION_26_2 < (dataVersions[other] ?? 0),
  '>': (other) => DATA_VERSION_26_2 > (dataVersions[other] ?? 0),
  '<=': (other) => DATA_VERSION_26_2 <= (dataVersions[other] ?? 0),
  '==': (other) => DATA_VERSION_26_2 === (dataVersions[other] ?? 0)
}

nmcData.version = version26_2
nmcData.isNewerOrEqualTo = (v) => version26_2['>='](v)
nmcData.isOlderThan = (v) => version26_2['<'](v)

// Wrap base supportFeature — add liquid gravity features missing from base features.json
const baseSupportFeature = supportFeature(version26_2, base.versions.pc)
nmcData.supportFeature = (feature) => {
  if (feature === 'independentLiquidGravity') return true
  if (feature === 'proportionalLiquidGravity') return false
  return baseSupportFeature(feature)
}

// ---------------------------------------------------------------------------
// Export: wrap the real package, intercepting 26.2
// ---------------------------------------------------------------------------

module.exports = function (mcVersion) {
  if (String(mcVersion) === '26.2') {
    return nmcData
  }
  return base(mcVersion)
}

// Re-export everything from the base package
module.exports.Version = base.Version
module.exports.supportedVersions = base.supportedVersions
module.exports.versions = base.versions
module.exports.versionsByMinecraftVersion = base.versionsByMinecraftVersion
module.exports.preNettyVersionsByProtocolVersion = base.preNettyVersionsByProtocolVersion
module.exports.postNettyVersionsByProtocolVersion = base.postNettyVersionsByProtocolVersion
module.exports.legacy = base.legacy
module.exports.schemas = base.schemas
