$link = "https://github.com/mendo0oo/Nullcord/releases/latest/download/NullCordInstallerCli.exe"

$outfile = "$env:TEMP\NullCordInstallerCli.exe"

Write-Output "Downloading installer to $outfile"

Invoke-WebRequest -Uri "$link" -OutFile "$outfile"

Write-Output ""

Start-Process -Wait -NoNewWindow -FilePath "$outfile"

# Cleanup
Remove-Item -Force "$outfile"
