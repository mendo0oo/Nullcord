const assert = require("node:assert/strict");
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const dist = path.join(__dirname, "..", "dist");

test("packages the NullCord logo with a file-compatible URL", () => {
    assert.equal(existsSync(path.join(dist, "NullCordIcon.png")), true, "dist/NullCordIcon.png is missing");

    const bundleName = readdirSync(path.join(dist, "assets")).find(name => /^index-.+\.js$/.test(name));
    assert.ok(bundleName, "compiled installer JavaScript bundle is missing");
    const bundle = readFileSync(path.join(dist, "assets", bundleName), "utf8");
    assert.match(bundle, /\.\/NullCordIcon\.png/, "logo URL must be relative for Electron file:// pages");
    assert.doesNotMatch(bundle, /[\"']\/NullCordIcon\.png[\"']/, "root-absolute logo URL breaks in Electron");
});
