Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$files = Get-ChildItem -Path "test" -File |
	Where-Object { $_.Extension -in ".mac", ".cls", ".int", ".inc", ".csp" } |
	Select-Object -ExpandProperty FullName

if (-not $files -or $files.Count -eq 0) {
	Write-Error "No test files found under ./test"
}

& node "out/lint.js" @files
exit $LASTEXITCODE
