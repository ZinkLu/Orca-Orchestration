export interface EmbeddedAsset {
  type: string;
  /** base64-encoded file contents */
  body: string;
}

/**
 * Load the web assets embedded into the compiled binary.
 *
 * `scripts/build-binary.mjs` writes `./generated/webAssets.ts` (a base64 map of
 * everything under `web/dist`) right before `bun build --compile`, so the module
 * exists and gets bundled into the standalone binary. In a dev checkout it's
 * absent — the dynamic import throws and we return an empty map, which makes the
 * server fall back to serving `web/dist` from disk (or nothing, in `npm run dev`
 * where Vite owns the UI).
 */
export async function loadEmbeddedAssets(): Promise<Map<string, { type: string; body: Buffer }>> {
  const map = new Map<string, { type: string; body: Buffer }>();
  try {
    // @ts-ignore — generated at build time, may not exist in a dev checkout.
    const mod: { WEB_ASSETS: Record<string, EmbeddedAsset> } = await import("./generated/webAssets");
    for (const [path, asset] of Object.entries(mod.WEB_ASSETS)) {
      map.set(path, { type: asset.type, body: Buffer.from(asset.body, "base64") });
    }
  } catch {
    // no embedded assets (dev run) — caller falls back to disk
  }
  return map;
}

/**
 * The text of `skill/SKILL.md`, embedded alongside the web assets.
 *
 * The standalone binary has no package directory to read the skill from, but
 * `orca-dag` installs the skill on startup — so the same generated module
 * carries it. Returns null in a dev checkout / npm install, where `skill.ts`
 * finds the real file on disk instead.
 */
export async function loadEmbeddedSkill(): Promise<string | null> {
  try {
    // @ts-ignore — generated at build time, may not exist in a dev checkout.
    const mod: { SKILL_MD?: string } = await import("./generated/webAssets");
    return mod.SKILL_MD ?? null;
  } catch {
    return null;
  }
}
