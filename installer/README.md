# NullCord Installer

Cross-platform GUI/CLI installer for [NullCord](https://github.com/mendo0oo/Nullcord), based on the GPL-licensed [Vencord Installer](https://github.com/Vencord/Installer).

The installer discovers Discord Stable, PTB, and Canary installations; downloads the latest NullCord desktop build from this repository's GitHub release; patches Discord; and can repair or fully unpatch it.

## Release builds

Tag the main repository with a version such as `v0.1.0`. The NullCord release workflow builds the client and installer together and publishes:

- `NullCordInstaller.exe`
- `NullCordInstallerCli.exe`
- `NullCordInstallerCli-linux`
- `NullCordInstaller.MacOS.zip`
- NullCord client runtime assets used by the installer

## Local CLI build

Requires Go 1.22 or newer:

```sh
cd installer
go build -tags cli -o NullCordInstallerCli
```

The GUI requires CGO plus the platform dependencies documented by the upstream installer project.
