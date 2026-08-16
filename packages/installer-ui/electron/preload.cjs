const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nullcordInstaller", {
    run: request => ipcRenderer.invoke("installer:run", request),
    onLog: callback => {
        const listener = (_event, line) => callback(line);
        ipcRenderer.on("installer:log", listener);
        return () => ipcRenderer.removeListener("installer:log", listener);
    }
});
