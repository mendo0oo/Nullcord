const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { once } = require("node:events");
const { createWriteStream, existsSync, readFileSync } = require("node:fs");
const { mkdir, rename, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");

const LATEST_RELEASE_URL = "https://api.github.com/repos/mendo0oo/Nullcord/releases/latest";
const INSTALLER_ASSET = "NullCordInstaller.exe";

function replacementScript() {
    return `param([int]$ParentPid, [string]$Source, [string]$Target, [string]$VersionFile, [string]$Version, [string]$Self, [string]$Log)
$ErrorActionPreference = "Stop"
function Write-UpdateLog([string]$Message) {
    Add-Content -LiteralPath $Log -Value "$(Get-Date -Format o) $Message" -Encoding UTF8 -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Path (Split-Path -Parent $Target) -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $Log) -Force | Out-Null
Write-UpdateLog "Waiting for installer process $ParentPid"
Wait-Process -Id $ParentPid -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
$copied = $false
for ($attempt = 1; $attempt -le 240; $attempt++) {
    try {
        Copy-Item -LiteralPath $Source -Destination $Target -Force -ErrorAction Stop
        if ((Get-Item -LiteralPath $Source).Length -ne (Get-Item -LiteralPath $Target).Length) {
            throw "Replacement file size does not match the downloaded update."
        }
        Set-Content -LiteralPath $VersionFile -Value $Version -Encoding ASCII
        $copied = $true
        Write-UpdateLog "Replaced $Target on attempt $attempt"
        break
    } catch {
        if ($attempt -eq 240) { Write-UpdateLog "Replacement failed: $($_.Exception.Message)" }
        Start-Sleep -Milliseconds 500
    }
}
try {
    if ($copied) {
        Start-Process -FilePath $Target -ErrorAction Stop
        Write-UpdateLog "Relaunched updated installer from $Target"
    } else {
        Start-Process -FilePath $Source -ErrorAction Stop
        Write-UpdateLog "Launched downloaded installer from fallback path $Source"
    }
} catch {
    Write-UpdateLog "Relaunch failed: $($_.Exception.Message)"
}

Remove-Item -LiteralPath $Self -Force -ErrorAction SilentlyContinue
`;
}

function managedPaths(app) {
    const root = path.join(process.env.LOCALAPPDATA || app.getPath("appData"), "NullCord", "Installer");
    return {
        executable: path.join(root, "NullCordInstaller.exe"),
        versionFile: path.join(root, "version.txt"),
        logFile: path.join(root, "updater.log")
    };
}

function redirectToManagedInstaller(app, currentVersion) {
    if (!app.isPackaged || process.platform !== "win32") return false;
    const managed = managedPaths(app);
    const runningPath = path.resolve(process.env.PORTABLE_EXECUTABLE_FILE || process.execPath);
    if (runningPath.toLowerCase() === path.resolve(managed.executable).toLowerCase() || !existsSync(managed.executable) || !existsSync(managed.versionFile)) return false;

    const managedVersion = readFileSync(managed.versionFile, "utf8").trim();
    if (!isNewerVersion(managedVersion, currentVersion)) return false;
    const child = spawn(managed.executable, [], { detached: true, windowsHide: true, stdio: "ignore" });
    child.unref();
    return true;
}

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

async function replaceAndRelaunch(app, updatePath, version) {
    const managed = managedPaths(app);
    const scriptPath = path.join(app.getPath("temp"), `NullCord-update-${process.pid}.ps1`);
    await mkdir(path.dirname(managed.executable), { recursive: true });
    await writeFile(scriptPath, replacementScript(), "utf8");

    const helper = spawn("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
        "-File", scriptPath,
        "-ParentPid", String(process.pid),
        "-Source", updatePath,
        "-Target", managed.executable,
        "-VersionFile", managed.versionFile,
        "-Version", version,
        "-Self", scriptPath,
        "-Log", managed.logFile
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
        await replaceAndRelaunch(app, updatePath, update.version);
        setTimeout(() => app.exit(0), 250);
        return true;
    } catch (error) {
        onState({ phase: "error", message: `Update check failed: ${error.message}` });
        return false;
    }
}

module.exports = { isNewerVersion, redirectToManagedInstaller, replacementScript, runAutoUpdate };
