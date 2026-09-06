/**
 * Render `build/icon.svg` into the icon files macOS wants.
 *
 * Electron does the rendering. `nativeImage` cannot read SVG, and pulling in a
 * rasteriser for one file would be a dependency the repo does not otherwise
 * need — but the app already ships a browser, so a hidden window loading the
 * SVG and capturing itself produces exactly what Chromium would draw.
 *
 * `sips` downscales and `iconutil` packs the `.icns`; both are part of macOS.
 * On any other platform the PNG is still written, which is what Windows and
 * Linux window icons use.
 *
 * Run with: npm run icon --workspace=@anthill/desktop
 */

const { app, BrowserWindow } = require("electron");
const { execFileSync } = require("node:child_process");
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const buildDir = join(__dirname, "..", "build");

/** The sizes an `.iconset` must contain, and the name each one takes. */
const ICONSET = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];

app
  .whenReady()
  .then(async () => {
    const svg = readFileSync(join(buildDir, "icon.svg"), "utf8");
    const window = new BrowserWindow({
      width: 1024,
      height: 1024,
      show: false,
      // Transparent, so the rounded corners are actually round rather than
      // sitting on a square that only looks right on a light background.
      transparent: true,
      frame: false,
      backgroundColor: "#00000000",
    });

    await window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        `<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`,
      )}`,
    );
    // One beat, so the SVG is painted before it is captured.
    await new Promise((resolve) => setTimeout(resolve, 600));

    const master = join(buildDir, "icon.png");
    writeFileSync(master, (await window.webContents.capturePage()).toPNG());
    console.log("wrote", master);

    if (process.platform === "darwin") {
      const iconset = join(buildDir, "icon.iconset");
      rmSync(iconset, { recursive: true, force: true });
      mkdirSync(iconset, { recursive: true });

      for (const [size, name] of ICONSET) {
        execFileSync(
          "sips",
          ["-z", String(size), String(size), master, "--out", join(iconset, name)],
          { stdio: "ignore" },
        );
      }
      execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(buildDir, "icon.icns")]);
      rmSync(iconset, { recursive: true, force: true });
      console.log("wrote", join(buildDir, "icon.icns"));
    }

    app.exit(0);
  })
  .catch((error) => {
    console.error("icon build failed:", error);
    app.exit(1);
  });
