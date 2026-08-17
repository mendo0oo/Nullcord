const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { once } = require("node:events");
const { createWriteStream } = require("node:fs");
const { mkdir, rename, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");

const LATEST_RELEASE_URL = "https://api.github.com/repos/mendo0oo/Nullcord/releases/latest";
const INSTALLER_ASSET = "NullCordInstaller.exe";

function parseVersion(version) {
    const match = String(version).trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i);
    return match ? match.slice(1).map(Number) : null;
}

function isNewerVersion(candidate, current) {
    const next = parseVersion(candidate);
    const installed = parseVersion(current);
    if (!next || !installed) return false;

    for (let index = 0; index < 3; index++) {
        if (next[index] !== installed[index]) return next[index] > installed[index];
    }
    return false;
}

async function getLatestInstaller() {
    const response = await fetch(LATEST_RELEASE_URL, {
        headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "NullCord-Installer-Updater"
        },
        signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`GitHub update check returned ${response.status}.`);

    const release = await response.json();
    const asset = release.assets?.find(item => item.name === INSTALLER_ASSET);
    if (!asset) throw new Error("The latest release does not contain the Windows installer.");
    const parsedVersion = parseVersion(release.tag_name);
    if (!parsedVersion) throw new Error("The latest GitHub release has an invalid version tag.");
    const downloadUrl = new URL(asset.browser_download_url);
    if (downloadUrl.protocol !== "https:" || downloadUrl.hostname !== "github.com" || !downloadUrl.pathname.startsWith("/mendo0oo/Nullcord/releases/download/"))
        throw new Error("GitHub returned an unexpected installer download URL.");

    return {
        version: parsedVersion.join("."),
        downloadUrl: downloadUrl.href,
        expectedSize: asset.size,
        digest: asset.digest
    };
}

async function downloadInstaller(update, destination, onProgress) {
    const partialPath = `${destination}.part`;
    await mkdir(path.dirname(destination), { recursive: true });
    await rm(partialPath, { force: true });

    const response = await fetch(update.downloadUrl, {
        headers: { "User-Agent": "NullCord-Installer-Updater" },
        signal: AbortSignal.timeout(600_000)
    });
    if (!response.ok || !response.body) throw new Error(`Installer download returned ${response.status}.`);

    const output = createWriteStream(partialPath, { flags: "wx" });
    const hash = createHash("sha256");
    let received = 0;

    try {
        for await (const chunk of response.body) {
            received += chunk.length;
            hash.update(chunk);
            if (!output.write(chunk)) await once(output, "drain");
            onProgress(Math.min(100, Math.round((received / update.expectedSize) * 100)));
        }
        output.end();
        await once(output, "finish");

        if (received !== update.expectedSize)
            throw new Error(`Downloaded ${received} bytes; expected ${update.expectedSize}.`);

        if (update.digest?.startsWith("sha256:") && hash.digest("hex") !== update.digest.slice(7).toLowerCase())
            throw new Error("The downloaded installer failed its SHA-256 verification.");

        await rm(destination, { force: true });
        await rename(partialPath, destination);
    } catch (error) {
        output.destroy();
        await rm(partialPath, { force: true });
        throw error;
    }
}

async function replaceAndRelaunch(app, updatePath) {
    const targetPath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const scriptPath = path.join(app.getPath("temp"), `NullCord-update-${process.pid}.ps1`);
    const script = `param([int]$ParentPid, [string]$Source, [string]$Target, [string]$Self)
Wait-Process -Id $ParentPid -ErrorAction SilentlyContinue
$copied = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
        Copy-Item -LiteralPath $Source -Destination $Target -Force -ErrorAction Stop
        $copied = $true
        break
    } catch {
        Start-Sleep -Milliseconds 250
    }
}
if ($copied) {
    Start-Process -FilePath $Target
    Remove-Item -LiteralPath $Source -Force -ErrorAction SilentlyContinue
} else {
    Start-Process -FilePath $Source
}
Remove-Item -LiteralPath $Self -Force -ErrorAction SilentlyContinue
`;
    await writeFile(scriptPath, script, "utf8");

    const helper = spawn("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
        "-File", scriptPath,
        "-ParentPid", String(process.pid),
        "-Source", updatePath,
        "-Target", targetPath,
        "-Self", scriptPath
    ], { detached: true, windowsHide: true, stdio: "ignore" });
    await new Promise((resolve, reject) => {
        helper.once("spawn", resolve);
        helper.once("error", reject);
    });
    helper.unref();
}

async function runAutoUpdate({ app, currentVersion, onState }) {
    if (!app.isPackaged || process.platform !== "win32") {
        onState({ phase: "current", message: "Development build — update check skipped." });
        return false;
    }

    try {
        onState({ phase: "checking", message: "Checking GitHub for installer updates…" });
        const update = await getLatestInstaller();
        if (!isNewerVersion(update.version, currentVersion)) {
            onState({ phase: "current", message: `NullCord Installer v${currentVersion} is current.` });
            return false;
        }

        onState({ phase: "downloading", version: update.version, progress: 0, message: `Downloading v${update.version}…` });
        const updatePath = path.join(app.getPath("temp"), "NullCord", "updates", `NullCordInstaller-${update.version}.exe`);
        await downloadInstaller(update, updatePath, progress => {
            onState({ phase: "downloading", version: update.version, progress, message: `Downloading v${update.version}… ${progress}%` });
        });

        onState({ phase: "restarting", version: update.version, progress: 100, message: "Update verified. Restarting NullCord Installer…" });
        await replaceAndRelaunch(app, updatePath);
        setTimeout(() => app.quit(), 400);
        return true;
    } catch (error) {
        onState({ phase: "error", message: `Update check failed: ${error.message}` });
        return false;
    }
}

module.exports = { isNewerVersion, runAutoUpdate };
