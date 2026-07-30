param(
  [string]$SkillRoot,
  [string]$OutputDir
)

$ErrorActionPreference = 'Stop'

function Resolve-Directory([string]$PathValue) {
  if (-not (Test-Path -LiteralPath $PathValue -PathType Container)) {
    throw "Directory not found: $PathValue"
  }
  return (Resolve-Path -LiteralPath $PathValue).Path
}

function Write-Utf8NoBom([string]$PathValue, [string]$Text) {
  $encoding = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($PathValue, $Text, $encoding)
}

if (-not $SkillRoot) {
  $SkillRoot = Join-Path $PSScriptRoot '..'
}
$SkillRoot = Resolve-Directory $SkillRoot

if (-not (Test-Path -LiteralPath (Join-Path $SkillRoot 'SKILL.md') -PathType Leaf)) {
  throw "SKILL.md not found under $SkillRoot"
}

if (-not $OutputDir) {
  $repoRoot = Split-Path $SkillRoot -Parent
  if (-not (Test-Path -LiteralPath (Join-Path $repoRoot '.git'))) {
    $repoRoot = Split-Path $repoRoot -Parent
  }
  $OutputDir = Join-Path $repoRoot 'packages'
}
if (-not (Test-Path -LiteralPath $OutputDir -PathType Container)) {
  New-Item -ItemType Directory -Path $OutputDir | Out-Null
}
$OutputDir = Resolve-Directory $OutputDir

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$zipPath = Join-Path $OutputDir "aibox-drpy-source-skill-$stamp.zip"
if (Test-Path -LiteralPath $zipPath) {
  throw "Package already exists: $zipPath"
}

$stageRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("aibox-skill-package-" + [System.Guid]::NewGuid().ToString('N'))
$stageSkill = Join-Path $stageRoot 'aibox-drpy-source'
New-Item -ItemType Directory -Path $stageSkill -Force | Out-Null

$excludedPrefixes = @(
  'node_modules',
  'output',
  'temp',
  'coverage',
  'assets\examples',
  'sources',
  'spider'
)

$excludedFiles = @(
  'config\aibox.config.json'
)

$excludedGlobs = @(
  '*.log',
  '*.tmp',
  '.DS_Store',
  'Thumbs.db'
)

function Test-Excluded([System.IO.FileSystemInfo]$Item, [string]$RelativePath) {
  $normalized = $RelativePath -replace '/', '\'
  foreach ($prefix in $excludedPrefixes) {
    if ($normalized -eq $prefix -or $normalized.StartsWith("$prefix\")) {
      return $true
    }
  }
  foreach ($file in $excludedFiles) {
    if ($normalized -ieq $file) {
      return $true
    }
  }
  foreach ($glob in $excludedGlobs) {
    if ($Item.Name -like $glob) {
      return $true
    }
  }
  return $false
}

$skillRootWithSlash = $SkillRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
$items = Get-ChildItem -LiteralPath $SkillRoot -Recurse -Force
foreach ($item in $items) {
  $relative = $item.FullName.Substring($skillRootWithSlash.Length)
  if (Test-Excluded $item $relative) {
    continue
  }
  $target = Join-Path $stageSkill $relative
  if ($item.PSIsContainer) {
    New-Item -ItemType Directory -Path $target -Force | Out-Null
  } else {
    $targetDir = Split-Path $target -Parent
    if (-not (Test-Path -LiteralPath $targetDir -PathType Container)) {
      New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    }
    Copy-Item -LiteralPath $item.FullName -Destination $target -Force
  }
}

$installText = @'
Aibox DRPY Source Skill

Install:
1. Extract this zip.
2. Copy the aibox-drpy-source folder into your Codex skills directory.
   Windows: %USERPROFILE%\.codex\skills\
   macOS/Linux: ~/.codex/skills/
3. Restart Codex and invoke the skill with $aibox-drpy-source.

Quick check:
  node .\aibox-drpy-source\scripts\aibox-skill-cli.mjs help
  node .\aibox-drpy-source\scripts\aibox-skill-cli.mjs resources list

Notes:
- This package contains no built-in site sources or user-generated rules.
- This package excludes node_modules/, output/, temp/, logs, and config/aibox.config.json.
- Run npm ci inside aibox-drpy-source after extraction.
- On Windows, if Python-based skill validation reads Chinese text as GBK, run it with PYTHONUTF8=1.
'@
Write-Utf8NoBom (Join-Path $stageRoot 'INSTALL.txt') $installText

$manifest = [ordered]@{
  name = 'aibox-drpy-source'
  package = (Split-Path $zipPath -Leaf)
  packagedAt = (Get-Date).ToUniversalTime().ToString('o')
  nodeModulesIncluded = $false
  builtInSourcesIncluded = $false
  included = @(
    'SKILL.md',
    'LICENSE',
    'agents/openai.yaml',
    'assets/',
    'config/aibox.config.example.json',
    'package.json',
    'package-lock.json',
    'references/',
    'scripts/',
    'template/',
    'vendor/'
  )
  excluded = @(
    'output/',
    'temp/',
    'coverage/',
    'node_modules/',
    'assets/examples/',
    'sources/',
    'spider/',
    'config/aibox.config.json',
    '*.log',
    '*.tmp'
  )
}
Write-Utf8NoBom (Join-Path $stageRoot 'PACKAGE_MANIFEST.json') ($manifest | ConvertTo-Json -Depth 5)

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $stageRoot,
  $zipPath,
  [System.IO.Compression.CompressionLevel]::Optimal,
  $false,
  [System.Text.Encoding]::UTF8
)

$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
$validationError = $null
try {
  $entries = @($zip.Entries | ForEach-Object { $_.FullName -replace '\\', '/' })
  $requiredEntries = @(
    'aibox-drpy-source/SKILL.md',
    'aibox-drpy-source/LICENSE',
    'aibox-drpy-source/agents/openai.yaml',
    'aibox-drpy-source/package.json',
    'aibox-drpy-source/package-lock.json',
    'aibox-drpy-source/scripts/aibox-skill-cli.mjs',
    'aibox-drpy-source/scripts/validate-public-package.mjs',
    'aibox-drpy-source/template/ds_template.js',
    'INSTALL.txt',
    'PACKAGE_MANIFEST.json'
  )
  foreach ($required in $requiredEntries) {
    if ($entries -notcontains $required) {
      $validationError = "Packaged zip is missing required entry: $required"
      break
    }
  }
  $forbidden = $entries | Where-Object {
    $_ -like 'aibox-drpy-source/output/*' -or
    $_ -like 'aibox-drpy-source/temp/*' -or
    $_ -like 'aibox-drpy-source/coverage/*' -or
    $_ -like 'aibox-drpy-source/node_modules/*' -or
    $_ -like 'aibox-drpy-source/assets/examples/*' -or
    $_ -like 'aibox-drpy-source/sources/*' -or
    $_ -like 'aibox-drpy-source/spider/*' -or
    $_ -eq 'aibox-drpy-source/config/aibox.config.json'
  }
  if ($forbidden.Count -gt 0) {
    $validationError = "Packaged zip contains forbidden entries: $($forbidden -join ', ')"
  }
} finally {
  $zip.Dispose()
}

$stageResolved = (Resolve-Path -LiteralPath $stageRoot).Path
$tempResolved = (Resolve-Path -LiteralPath ([System.IO.Path]::GetTempPath())).Path.TrimEnd('\', '/')
if ($stageResolved.StartsWith($tempResolved, [System.StringComparison]::OrdinalIgnoreCase) -and
    (Split-Path $stageResolved -Leaf).StartsWith('aibox-skill-package-', [System.StringComparison]::OrdinalIgnoreCase)) {
  Remove-Item -LiteralPath $stageResolved -Recurse -Force
}

if ($validationError) {
  if (Test-Path -LiteralPath $zipPath -PathType Leaf) {
    Remove-Item -LiteralPath $zipPath -Force
  }
  throw $validationError
}

$fileInfo = Get-Item -LiteralPath $zipPath
[pscustomobject]@{
  packagePath = $fileInfo.FullName
  sizeBytes = $fileInfo.Length
  nodeModulesIncluded = $false
  builtInSourcesIncluded = $false
}
