// Packaging. Two modes, picked by what's in the environment:
//
//   Developer ID (Atomic Chat parity) — when a signing certificate is present
//   (CSC_NAME, or CSC_LINK + CSC_KEY_PASSWORD) the app is signed with it, runs
//   under the hardened runtime, and is notarized if APPLE_ID,
//   APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID are set. A downloaded DMG then
//   opens with no warning at all.
//
//   Ad-hoc (default, free) — the whole bundle, runtime included, is sealed with
//   an ad-hoc signature. Without it a downloaded copy is reported as "damaged";
//   with it macOS asks once, under System Settings → Privacy & Security.
const developerId = Boolean(process.env.CSC_NAME || process.env.CSC_LINK)
const notarize = developerId && Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)
const { BUILD } = require('./electron/runtime.cjs')

module.exports = {
  appId: 'com.obcraft.jemero',
  productName: 'Jemero',
  directories: { output: 'release', buildResources: 'build' },
  // The main process uses only node builtins, so nothing from node_modules ships.
  files: ['electron/**/*', 'dist/**/*', 'package.json'],
  asar: true,
  // Beside the asar, not inside it: macOS can't exec a binary from an archive.
  extraResources: [{ from: `vendor/llama/llama-${BUILD}`, to: 'llama', filter: ['**/*'] }],
  mac: {
    target: [{ target: 'dmg', arch: ['arm64'] }],
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.icns',
    darkModeSupport: true,
    minimumSystemVersion: '13.0',
    identity: developerId ? undefined : '-',
    // The hardened runtime enforces library validation, which ad-hoc signed
    // dylibs (no team id) can't pass — llama-server would fail to load them.
    // It's only required for notarization, so it's on exactly when that is.
    hardenedRuntime: developerId,
    entitlements: developerId ? 'build/entitlements.mac.plist' : undefined,
    entitlementsInherit: developerId ? 'build/entitlements.mac.plist' : undefined,
    notarize,
  },
  // A stable name, so the landing page's "latest release" link never changes:
  // github.com/obcraft/jemero/releases/latest/download/Jemero-arm64.dmg
  artifactName: '${productName}-${arch}.${ext}',
  dmg: {
    title: 'Jemero',
    // Drawn by scripts/dmg-background.cjs (+ @2x beside it); its arrow sits
    // between the two icon positions below, so keep them in step.
    background: 'build/background.png',
    window: { width: 540, height: 380 },
    iconSize: 96,
    contents: [
      { x: 140, y: 170, type: 'file' },
      { x: 400, y: 170, type: 'link', path: '/Applications' },
    ],
  },
}
