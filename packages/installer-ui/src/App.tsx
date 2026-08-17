import { useEffect, useState } from "react";

type Action = "install" | "repair" | "uninstall";
type Branch = "auto" | "stable" | "ptb" | "canary";

const actions: Array<{ id: Action; title: string; detail: string; }> = [
    { id: "install", title: "Install", detail: "Add NullCord to your Discord client." },
    { id: "repair", title: "Repair", detail: "Refresh files and restore the patch." },
    { id: "uninstall", title: "Uninstall", detail: "Return Discord to its original state." }
];

const branches: Array<{ id: Branch; label: string; }> = [
    { id: "auto", label: "Automatic" },
    { id: "stable", label: "Stable" },
    { id: "ptb", label: "PTB" },
    { id: "canary", label: "Canary" }
];

// This must stay relative: the packaged installer loads the UI over file://.
const nullCordIcon = "./NullCordIcon.png";

export default function App() {
    const [action, setAction] = useState<Action>("install");
    const [branch, setBranch] = useState<Branch>("auto");
    const [busy, setBusy] = useState(false);
    const [complete, setComplete] = useState(false);
    const [message, setMessage] = useState("Ready when you are.");
    const [logs, setLogs] = useState<string[]>([]);
    const [update, setUpdate] = useState<InstallerUpdateState>({ phase: "checking", message: "Checking GitHub for installer updates…" });

    useEffect(() => {
        const bridge = window.nullcordInstaller;
        if (!bridge) {
            setUpdate({ phase: "current", message: "Preview mode" });
            return;
        }

        const removeLogListener = bridge.onLog(line => {
            setLogs(current => [...current.slice(-80), line.trim()].filter(Boolean));
        });
        const removeUpdateListener = bridge.onUpdateState(setUpdate);
        bridge.getUpdateState().then(setUpdate);
        return () => {
            removeLogListener();
            removeUpdateListener();
        };
    }, []);

    const updaterBusy = ["checking", "downloading", "restarting"].includes(update.phase);

    async function run() {
        setBusy(true);
        setComplete(false);
        setLogs([]);
        setMessage(`${actions.find(item => item.id === action)?.title} in progress…`);

        const bridge = window.nullcordInstaller;
        if (!bridge) {
            await new Promise(resolve => setTimeout(resolve, 900));
            setBusy(false);
            setComplete(true);
            setMessage("Preview complete — the packaged app connects this screen to the native installer.");
            return;
        }

        const result = await bridge.run({ action, branch });
        setBusy(false);
        setComplete(result.ok);
        setMessage(result.ok ? "Done. You can launch Discord now." : result.error ?? "The operation failed.");
    }

    return (
        <main className="shell">
            <aside className="rail">
                <div className="brand-mark" aria-hidden="true"><img src={nullCordIcon} alt="" /></div>
                <div className="rail-line" />
                <span>01</span><span>02</span><span>03</span>
            </aside>

            <section className="workspace">
                <header>
                    <div>
                        <p className="eyebrow">NULLCORD / DESKTOP</p>
                        <h1>Make Discord<br />feel like yours.</h1>
                    </div>
                    <div className={update.phase === "error" ? "version-pill warning" : "version-pill"} title={update.phase === "error" ? update.message : undefined}><i /> v0.6.1</div>
                </header>

                <div className="content-grid">
                    <section className="setup-card">
                        <div className="section-heading">
                            <span>01</span>
                            <div><h2>Choose an action</h2><p>Everything is reversible.</p></div>
                        </div>
                        <div className="action-grid">
                            {actions.map(item => (
                                <button key={item.id} className={action === item.id ? "action active" : "action"} onClick={() => setAction(item.id)}>
                                    <span className="radio" />
                                    <strong>{item.title}</strong>
                                    <small>{item.detail}</small>
                                </button>
                            ))}
                        </div>

                        <div className="section-heading second">
                            <span>02</span>
                            <div><h2>Discord channel</h2><p>Automatic is recommended.</p></div>
                        </div>
                        <div className="branch-row">
                            {branches.map(item => (
                                <button key={item.id} className={branch === item.id ? "branch active" : "branch"} onClick={() => setBranch(item.id)}>{item.label}</button>
                            ))}
                        </div>
                    </section>

                    <aside className="summary-card">
                        <p className="eyebrow">SUMMARY</p>
                        <div className="summary-icon"><img src={nullCordIcon} alt="" /></div>
                        <h3>{actions.find(item => item.id === action)?.title} NullCord</h3>
                        <p>{branch === "auto" ? "Best Discord installation found automatically" : `Discord ${branch.toUpperCase()}`}</p>
                        <dl>
                            <div><dt>Source</dt><dd>GitHub release</dd></div>
                            <div><dt>Profile</dt><dd>NullCord isolated</dd></div>
                            <div><dt>Rollback</dt><dd>Available</dd></div>
                        </dl>
                        <button className="primary" disabled={busy || updaterBusy} onClick={run}>{busy ? "Working…" : `${actions.find(item => item.id === action)?.title} NullCord`} <span>→</span></button>
                        <p className={complete ? "status success" : "status"}>{message}</p>
                    </aside>
                </div>

                {logs.length > 0 && <pre className="log-panel">{logs.join("\n")}</pre>}
                <footer><span>Open source · GPL-3.0</span><span>No Discord token required</span></footer>
            </section>

            {updaterBusy && (
                <section className="update-overlay" role="status" aria-live="polite">
                    <div className="update-dialog">
                        <img src={nullCordIcon} alt="" />
                        <p className="eyebrow">NULLCORD / UPDATE</p>
                        <h2>{update.phase === "checking" ? "Checking for updates" : update.phase === "restarting" ? "Restarting installer" : "Installing the latest version"}</h2>
                        <p>{update.message}</p>
                        <div className={update.phase === "checking" ? "update-progress indeterminate" : "update-progress"}>
                            <span style={{ width: `${update.progress ?? 24}%` }} />
                        </div>
                        <small>Updates are downloaded securely from the official NullCord GitHub release.</small>
                    </div>
                </section>
            )}
        </main>
    );
}
