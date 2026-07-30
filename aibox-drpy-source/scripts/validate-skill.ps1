$ErrorActionPreference = 'Stop'

$skillRoot = Split-Path -Parent $PSScriptRoot
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$validator = Join-Path $codexHome 'skills\.system\skill-creator\scripts\quick_validate.py'

if (-not (Test-Path -LiteralPath $validator)) {
    throw "未找到 skill-creator 校验器: $validator"
}

python -X utf8 $validator $skillRoot
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
