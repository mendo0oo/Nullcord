/// <reference types="vite/client" />

interface InstallerResult {
    ok: boolean;
    error?: string;
}

interface InstallerUpdateState {
    phase: "checking" | "current" | "downloading" | "restarting" | "error";
    message: string;
    progress?: number;
    version?: string;
}

interface Window {
    nullcordInstaller?: {
        getVersion(): Promise<string>;
        run(request: { action: string; branch: string; }): Promise<InstallerResult>;
        getUpdateState(): Promise<InstallerUpdateState>;
        onUpdateState(callback: (state: InstallerUpdateState) => void): () => void;
        onLog(callback: (line: string) => void): () => void;
    };
}
