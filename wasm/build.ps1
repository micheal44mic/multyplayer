# Rebuilds the core and copies the artifact to the path loaded by the app.
# The app does NOT require this step: js/raster_core.wasm is committed.
# Use it only after changing wasm/src/lib.rs.
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
  cargo build --release
  Copy-Item "target/wasm32-unknown-unknown/release/raster_core.wasm" "../js/raster_core.wasm" -Force
  $size = (Get-Item "../js/raster_core.wasm").Length
  Write-Host "ok: js/raster_core.wasm ($size bytes)"
} finally {
  Pop-Location
}
