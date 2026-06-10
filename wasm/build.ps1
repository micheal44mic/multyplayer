# Ricompila il core e copia l'artefatto dove l'app lo carica.
# L'app NON richiede questo passo: js/raster_core.wasm è committato;
# serve solo dopo aver modificato wasm/src/lib.rs.
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
  cargo build --release
  Copy-Item "target/wasm32-unknown-unknown/release/raster_core.wasm" "../js/raster_core.wasm" -Force
  $size = (Get-Item "../js/raster_core.wasm").Length
  Write-Host "ok: js/raster_core.wasm ($size byte)"
} finally {
  Pop-Location
}
