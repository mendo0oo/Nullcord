/// <reference types="vite/client" />

interface InstallerResult {
    ok: boolean;
    error?: string;
}

interface Window {
    nullcordInstaller?: {
        run(request: { action: string; branch: string; }): Promise<InstallerResult>;
        onLog(callback: (line: string) => void): () => void;
    };
}
