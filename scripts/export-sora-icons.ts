#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone Sharp asset exporter uses Node buffers and top-level async I/O.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import sharp from "sharp";
import { BRAND_ASSET_PATHS, DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const root = NodePath.resolve(import.meta.dirname, "..");
const source = await NodeFSP.readFile(NodePath.resolve(root, "assets/sora/logo.png"));
const check = process.argv.includes("--check");
const outputs = new Map<string, Buffer>();
const resize = (size: number) => sharp(source).resize(size, size).removeAlpha().png().toBuffer();
const variants = [
  {
    ios: BRAND_ASSET_PATHS.developmentIosIconPng,
    mac: BRAND_ASSET_PATHS.developmentDesktopIconPng,
    universal: BRAND_ASSET_PATHS.developmentUniversalIconPng,
    windows: BRAND_ASSET_PATHS.developmentWindowsIconIco,
    favicon: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    small: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    medium: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    touch: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
  },
  {
    ios: BRAND_ASSET_PATHS.nightlyIosIconPng,
    mac: BRAND_ASSET_PATHS.nightlyMacIconPng,
    universal: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
    windows: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    favicon: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    small: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
    medium: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
    touch: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
  },
  {
    ios: BRAND_ASSET_PATHS.productionIosIconPng,
    mac: BRAND_ASSET_PATHS.productionMacIconPng,
    universal: BRAND_ASSET_PATHS.productionLinuxIconPng,
    windows: BRAND_ASSET_PATHS.productionWindowsIconIco,
    favicon: BRAND_ASSET_PATHS.productionWebFaviconIco,
    small: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    medium: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    touch: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
  },
];
const photo = await resize(1024);
for (const variant of ["dev", "nightly", "prod"]) {
  outputs.set(`assets/${variant}/app-icon.icon/Assets/sora.png`, photo);
  outputs.set(
    `assets/${variant}/app-icon.icon/icon.json`,
    Buffer.from(
      JSON.stringify(
        {
          fill: { solid: "srgb:0,0,0,1" },
          groups: [
            {
              layers: [
                {
                  "image-name": "sora.png",
                  name: "Sora",
                  glass: false,
                  position: { scale: 1 },
                },
              ],
            },
          ],
          "supported-platforms": { squares: "shared" },
        },
        null,
        2,
      ) + "\n",
    ),
  );
}
const rounded = async (size: number, radius: number) =>
  sharp(await resize(size))
    .ensureAlpha()
    .composite([
      {
        input: Buffer.from(
          `<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" fill="white"/></svg>`,
        ),
        blend: "dest-in",
      },
    ])
    .png()
    .toBuffer();
// Keep the existing macOS 824px icon body and 100px safe-area inset.
const mac = await sharp({
  create: { width: 1024, height: 1024, channels: 4, background: "#00000000" },
})
  .composite([
    {
      input: Buffer.from(
        '<svg width="1024" height="1024"><defs><filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="8"/></filter></defs><rect x="100" y="108" width="824" height="824" rx="185" fill="black" opacity="0.22" filter="url(#shadow)"/></svg>',
      ),
    },
    { input: await rounded(824, 185), left: 100, top: 100 },
  ])
  .png()
  .toBuffer();
const universal = await rounded(1024, 230);
const windows = encodePngIco(
  await Promise.all(
    WINDOWS_ICON_SIZES.map(async (size) => ({ size, contents: await resize(size) })),
  ),
);
const favicon = encodePngIco(
  await Promise.all([16, 32, 48].map(async (size) => ({ size, contents: await resize(size) }))),
);
for (const variant of variants) {
  outputs.set(variant.ios, photo);
  outputs.set(variant.mac, mac);
  outputs.set(variant.universal, universal);
  outputs.set(variant.windows, windows);
  outputs.set(variant.favicon, favicon);
  outputs.set(variant.small, await resize(16));
  outputs.set(variant.medium, await resize(32));
  outputs.set(variant.touch, await resize(180));
}
for (const override of DEVELOPMENT_PUBLIC_ICON_OVERRIDES) {
  const source = outputs.get(override.sourceRelativePath);
  if (!source) throw new Error(`Missing icon source: ${override.sourceRelativePath}`);
  outputs.set(override.targetRelativePath, source);
}
const mark = await resize(128);
outputs.set("assets/sora/mark.png", mark);
outputs.set("apps/web/public/sora-mark.png", mark);
const markUrl = `data:image/png;base64,${mark.toString("base64")}`;
outputs.set(
  "assets/prod/logo.svg",
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><image href="${markUrl}" width="128" height="128"/></svg>\n`,
  ),
);
for (const variant of ["latest", "nightly"]) {
  const path = `apps/desktop/resources/dmg/dmg-background-${variant}.svg`;
  const original = await NodeFSP.readFile(NodePath.resolve(root, path), "utf8");
  const updated = original.replace(
    /(?:<!-- Official mark[^]*?-->\s*)?<svg x="32"[^]*?<\/svg>|<image id="sora-mark"[^]*?\/>/,
    `<image id="sora-mark" x="32" y="20" width="24" height="24" href="${markUrl}"/>`,
  );
  outputs.set(path, Buffer.from(updated));
}
outputs.set("apps/mobile/assets/widget/SoraMark.png", await resize(128));
// Android masks the background itself; a transparent foreground avoids double framing.
outputs.set(
  "apps/mobile/assets/android-icon-foreground.png",
  await sharp({ create: { width: 432, height: 432, channels: 4, background: "#00000000" } })
    .png()
    .toBuffer(),
);
for (const variant of ["dev", "nightly", "prod"]) {
  outputs.set(`apps/mobile/assets/android-icon-background-${variant}.png`, await resize(432));
  outputs.set(`apps/mobile/assets/android-splash-icon-${variant}.png`, await resize(1152));
}
// Themed launcher and notification icons accept only a single-color alpha mask.
for (const [path, size, inset] of [
  ["apps/mobile/assets/android-icon-mark.png", 432, 72],
  ["apps/mobile/assets/android-notification-icon.png", 96, 0],
] as const) {
  const body = size - inset * 2;
  const alpha = await sharp(source)
    .resize(body, body)
    .greyscale()
    .negate()
    .linear(2, -100)
    .raw()
    .toBuffer();
  const mask = await sharp({
    create: { width: body, height: body, channels: 3, background: "white" },
  })
    .joinChannel(alpha, { raw: { width: body, height: body, channels: 1 } })
    .png()
    .toBuffer();
  outputs.set(
    path,
    await sharp({ create: { width: size, height: size, channels: 4, background: "#00000000" } })
      .composite([{ input: mask, top: inset, left: inset }])
      .png()
      .toBuffer(),
  );
}
const notification = outputs.get("apps/mobile/assets/android-notification-icon.png");
if (!notification) throw new Error("Missing notification mask");
outputs.set(
  "apps/mobile/modules/t3-agent-notifications/android/src/main/res/drawable-xxxhdpi/agent_activity_mark.png",
  notification,
);
const stale: string[] = [];
for (const [path, bytes] of outputs) {
  const target = NodePath.resolve(root, path);
  if (check) {
    const existing = await NodeFSP.readFile(target).catch(() => undefined);
    if (!existing?.equals(bytes)) stale.push(path);
  } else {
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.writeFile(target, bytes);
  }
}
if (stale.length) throw new Error(`Stale Sora icons:\n${stale.join("\n")}`);
console.log(`${check ? "Checked" : "Generated"} ${outputs.size} Sora icon assets.`);
