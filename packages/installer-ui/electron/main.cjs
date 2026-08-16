const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");

let activeProcess;

function createWindow() {
    const window = new BrowserWindow({
        width: 1040,
        height: 720,
        minWidth: 880,
        minHeight: 620,
        title: "NullCord Installer",
        backgroundColor: "#f3f3f1",
        autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, "preload.cjs")
        }
    });

    window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

ipcMain.handle("installer:run", async (event, { action, branch }) => {
    if (activeProcess) return { ok: false, error: "An installer task is already running." };

    const allowedActions = new Set(["install", "repair", "uninstall"]);
    const allowedBranches = new Set(["auto", "stable", "ptb", "canary"]);
    if (!allowedActions.has(action) || !allowedBranches.has(branch))
        return { ok: false, error: "Invalid installer request." };

    const binary = path.join(process.resourcesPath, "bin", "NullCordInstallerCli.exe");
    const args = [`--${action}`, "--branch", branch];

    return await new Promise(resolve => {
        activeProcess = spawn(binary, args, { windowsHide: true });
        const forward = chunk => event.sender.send("installer:log", chunk.toString());
        activeProcess.stdout.on("data", forward);
        activeProcess.stderr.on("data", forward);
        activeProcess.once("error", error => {
            activeProcess = undefined;
            resolve({ ok: false, error: error.message });
        });
        activeProcess.once("exit", code => {
            activeProcess = undefined;
            resolve(code === 0 ? { ok: true } : { ok: false, error: `Installer exited with code ${code}.` });
        });
    });
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
