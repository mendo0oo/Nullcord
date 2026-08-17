const assert = require("node:assert/strict");
const test = require("node:test");

const { isNewerVersion, replacementScript } = require("../electron/updater.cjs");

test("recognises newer GitHub release versions", () => {
    assert.equal(isNewerVersion("0.3.1", "0.3.0"), true);
    assert.equal(isNewerVersion("v1.0.0", "0.9.9"), true);
    assert.equal(isNewerVersion("0.10.0", "0.9.9"), true);
});

test("does not downgrade or repeat the current version", () => {
    assert.equal(isNewerVersion("0.3.0", "0.3.0"), false);
    assert.equal(isNewerVersion("0.2.9", "0.3.0"), false);
    assert.equal(isNewerVersion("invalid", "0.3.0"), false);
});

test("portable replacement waits for locks and retains a fallback", () => {
    const script = replacementScript();
    assert.match(script, /attempt -le 240/);
    assert.match(script, /Replacement file size does not match/);
    assert.match(script, /Start-Process -FilePath \$Source/);
    assert.match(script, /updater process|Waiting for installer process/);
});
