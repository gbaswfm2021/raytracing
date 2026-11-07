# Builds applications/raytrace/.runtime/raytrace2d.exe with the .NET Framework C# compiler
# that ships with Windows (no Visual Studio, Rust, or Python needed).
#   powershell -ExecutionPolicy Bypass -File applications\raytrace\solver\build.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc = Get-ChildItem "$env:WINDIR\Microsoft.NET\Framework64\v4*\csc.exe" | Sort-Object FullName | Select-Object -Last 1
if (-not $csc) { throw 'csc.exe (.NET Framework 4) was not found.' }
$outDir = Join-Path (Split-Path -Parent $here) '.runtime'
New-Item -ItemType Directory -Force $outDir | Out-Null
$out = Join-Path $outDir 'raytrace2d.exe'
& $csc.FullName /nologo /optimize+ /target:exe /platform:anycpu "/out:$out" /reference:System.Web.Extensions.dll (Join-Path $here 'RayTrace2D.cs')
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }
Write-Host "Built $out"
