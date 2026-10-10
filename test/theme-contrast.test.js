import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../public/theme.css", import.meta.url), "utf8");
const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const style = await readFile(new URL("../public/style.css", import.meta.url), "utf8");

function declarations(block) {
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*([^;]+);/g)]
      .map(([, name, value]) => [name, value.trim()])
  );
}

function block(pattern, label) {
  const match = css.match(pattern);
  assert.ok(match, `theme.css has a ${label} token block`);
  return declarations(match[1]);
}

function styleDeclarations(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rules = [...style.matchAll(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]+)\\}`, "g"))];
  assert.ok(rules.length, `style.css has a ${selector} rule`);
  return Object.fromEntries(
    [...rules.at(-1)[1].matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;{}]+)/g)]
      .map(([, name, value]) => [name, value.trim()])
  );
}

const themes = {
  light: block(/:root\s*\{([^}]+)\}/, "light"),
  darkPreferred: block(/:root:not\(\[data-theme="light"\]\)\s*\{([^}]+)\}/, "preferred dark"),
  darkExplicit: block(/:root\[data-theme="dark"\]\s*\{([^}]+)\}/, "explicit dark")
};

function luminance(value) {
  assert.match(value, /^#[\da-f]{3}(?:[\da-f]{3})?$/i, `expected a hex color, got ${value}`);
  const hex = value.length === 4
    ? [...value.slice(1)].map((digit) => digit + digit).join("")
    : value.slice(1);
  const channels = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground, background) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function blend(foreground, background, foregroundWeight) {
  const channels = (hex) => {
    const value = hex.length === 4 ? [...hex.slice(1)].map((digit) => digit + digit).join("") : hex.slice(1);
    return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
  };
  const first = channels(foreground), second = channels(background);
  return `#${first.map((channel, index) => Math.round(channel * foregroundWeight + second[index] * (1 - foregroundWeight))
    .toString(16).padStart(2, "0")).join("")}`;
}

const textPairs = [
  ["text", "panel"], ["text", "panel-2"], ["text", "bg"],
  ["muted", "panel"], ["muted", "bg"],
  ["accent", "panel"], ["accent", "bg"],
  ["on-accent", "accent"],
  ["ok", "panel"], ["warn", "panel"], ["crit", "panel"], ["info", "panel"],
];

for (const [name, theme] of Object.entries(themes)) {
  test(`${name} theme text pairs meet WCAG AA`, () => {
    for (const [foreground, background] of textPairs) {
      const ratio = contrast(theme[foreground], theme[background]);
      assert.ok(
        ratio >= 4.5,
        `${name} --${foreground} on --${background} has ${ratio.toFixed(2)}:1 contrast; expected at least 4.5:1`
      );
    }
  });

  test(`${name} theme keeps focus and track marks visible`, () => {
    const focusToken = theme["focus-color"] || themes.light["focus-color"];
    const focusReference = focusToken.match(/^var\(--([\w-]+)\)$/);
    const focus = focusReference ? theme[focusReference[1]] : focusToken;
    for (const background of ["panel", "bg"]) {
      const ratio = contrast(focus, theme[background]);
      assert.ok(
        ratio >= 3,
        `${name} focus color on --${background} has ${ratio.toFixed(2)}:1 contrast; expected at least 3:1`
      );
    }
    for (const mark of ["faint", "idle", "track"]) {
      const ratio = contrast(theme[mark], theme.panel);
      assert.ok(
        ratio >= 3,
        `${name} --${mark} on --panel has ${ratio.toFixed(2)}:1 contrast; expected at least 3:1`
      );
    }
  });
}

test("Projects cards and tabs set explicit text colors above the global dark button rule", () => {
  assert.equal(styleDeclarations(":root:root .project-card-button").color, "var(--text)");
  assert.equal(styleDeclarations(".project-card-title").color, "var(--text)");
  assert.equal(styleDeclarations(":root:root .project-page-tabs button").color, "var(--muted)");
  assert.equal(styleDeclarations(":root:root .project-page-tabs button[aria-pressed=\"true\"]").color, "var(--text)");
});

test("share bar labels keep readable contrast over every project segment color", () => {
  const label = styleDeclarations(".allocation-label");
  assert.equal(label.color, "var(--text)");
  assert.equal(label.background, "color-mix(in srgb, var(--panel) 85%, transparent)");
  for (const [name, theme] of Object.entries(themes)) {
    for (const segment of ["accent", "info", "st-doing", "st-ready", "st-review"]) {
      const surface = blend(theme.panel, theme[segment], 0.85);
      const ratio = contrast(theme.text, surface);
      assert.ok(ratio >= 4.5, `${name} --text on allocation ${segment} label has ${ratio.toFixed(2)}:1 contrast`);
    }
  }
});

test("project allocation uses only cool project colors and keeps labels and swatches readable", () => {
  const palette = app.match(/const SHARE_COLORS = \[([^;]+)\];/)[1];
  const tokens = [...palette.matchAll(/var\(--([\w-]+)\)/g)].map(([, token]) => token);
  assert.deepEqual(tokens, ["accent", "info", "st-doing", "st-ready", "st-review"]);
  for (const [name, theme] of Object.entries(themes)) {
    for (const token of tokens) {
      for (const background of ["panel", "panel-2"]) {
        const ratio = contrast(theme[token], theme[background]);
        assert.ok(ratio >= 3, `${name} allocation ${token} swatch on ${background} has ${ratio.toFixed(2)}:1 contrast`);
      }
      const labelSurface = blend(theme.panel, theme[token], 0.85);
      assert.ok(contrast(theme.text, labelSurface) >= 4.5, `${name} allocation ${token} label meets AA`);
    }
  }
});

test("parked and transferring allocations have patterns and idle projects keep their cool color", () => {
  assert.ok(/\.allocation-segment\.parked[^}]*repeating-linear-gradient/.test(style), "parked segments have a hatch");
  assert.ok(/\.allocation-segment\.transferring[^}]*repeating-linear-gradient/.test(style), "transferring segments have a hatch");
  assert.equal(styleDeclarations(".allocation-segment.idle")["background-image"], "none");
  assert.equal(styleDeclarations(".project-selector.has-allocation.idle::before")["background-image"], "none");
});

test("preferred and explicit dark palettes stay identical", () => {
  assert.deepEqual(themes.darkPreferred, themes.darkExplicit);
});
