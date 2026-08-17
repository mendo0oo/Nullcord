const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nullcordInstaller", {
    run: request => ipcRenderer.invoke("installer:run", request),
    getVersion: () => ipcRenderer.invoke("installer:get-version"),
    getUpdateState: () => ipcRenderer.invoke("installer:get-update-state"),
    onUpdateState: callback => {
        const listener = (_event, state) => callback(state);
        ipcRenderer.on("installer:update-state", listener);
        return () => ipcRenderer.removeListener("installer:update-state", listener);
    },
    onLog: callback => {
        const listener = (_event, line) => callback(line);
        ipcRenderer.on("installer:log", listener);
        return () => ipcRenderer.removeListener("installer:log", listener);
    }
});
