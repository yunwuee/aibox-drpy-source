param(
  [string]$SkillRoot,
  [string]$OutputDir,
  [string]$PackageName
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
$packageJsonPath = Join-Path $SkillRoot 'package.json'
if (-not (Test-Path -LiteralPath $packageJsonPath -PathType Leaf)) {
  throw "package.json not found under $SkillRoot"
}
$packageMetadata = Get-Content -Raw -Encoding UTF8 -LiteralPath $packageJsonPath | ConvertFrom-Json

$repoRoot = Split-Path $SkillRoot -Parent
if (-not $OutputDir) {
  $OutputDir = Join-Path $repoRoot 'packages'
}
if (-not (Test-Path -LiteralPath $OutputDir -PathType Container)) {
  New-Item -ItemType Directory -Path $OutputDir | Out-Null
}
$OutputDir = Resolve-Directory $OutputDir

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if ($PackageName) {
  if ([System.IO.Path]::GetFileName($PackageName) -ne $PackageName -or
      [System.IO.Path]::GetExtension($PackageName) -ne '.zip') {
    throw 'PackageName must be a .zip file name without a directory'
  }
  $zipFileName = $PackageName
} else {
  $zipFileName = "aibox-drpy-source-skill-$stamp.zip"
}
$zipPath = Join-Path $OutputDir $zipFileName
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

foreach ($rootFile in @('README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md')) {
  $source = Join-Path $repoRoot $rootFile
  if (Test-Path -LiteralPath $source -PathType Leaf) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $stageRoot $rootFile) -Force
  }
}

$installText = @'
Aibox DRPY Source Skill

Install:
1. Extract this zip.
2. Copy the aibox-drpy-source folder into your Codex skills directory.
   Windows: %USERPROFILE%\.codex\skills\
   macOS/Linux: ~/.codex/skills/
3. Run npm ci inside the installed aibox-drpy-source directory.
4. Restart Codex and invoke the skill with $aibox-drpy-source.

Quick check:
  node .\aibox-drpy-source\scripts\aibox-skill-cli.mjs help
  node .\aibox-drpy-source\scripts\aibox-skill-cli.mjs doctor
  node .\aibox-drpy-source\scripts\aibox-skill-cli.mjs resources list

Example prompt:
  Use $aibox-drpy-source to analyze https://example.com, generate an Aibox
  DS source from real evidence, and complete the required L1/L2/L3 checks.

Notes:
- This package contains no built-in site sources or user-generated rules.
- This package excludes node_modules/, output/, temp/, logs, and config/aibox.config.json.
- Read LICENSE before using the Skill. This is a source-available package, not an MIT package.
- Read README.md for detailed installation, prompts, commands, and safety boundaries.
- On Windows, if Python-based skill validation reads Chinese text as GBK, run it with PYTHONUTF8=1.
'@
Write-Utf8NoBom (Join-Path $stageRoot 'INSTALL.txt') $installText

$manifest = [ordered]@{
  name = 'aibox-drpy-source'
  version = [string]$packageMetadata.version
  package = (Split-Path $zipPath -Leaf)
  packagedAt = (Get-Date).ToUniversalTime().ToString('o')
  author = 'yunwuee'
  authorUrl = 'https://github.com/yunwuee'
  contact = 'yunwuee@gmail.com'
  license = [string]$packageMetadata.license
  licenseFile = 'LICENSE'
  nodeModulesIncluded = $false
  builtInSourcesIncluded = $false
  included = @(
    'README.md',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'aibox-drpy-source/SKILL.md',
    'aibox-drpy-source/LICENSE',
    'aibox-drpy-source/agents/openai.yaml',
    'aibox-drpy-source/assets/',
    'aibox-drpy-source/config/aibox.config.example.json',
    'aibox-drpy-source/package.json',
    'aibox-drpy-source/package-lock.json',
    'aibox-drpy-source/references/',
    'aibox-drpy-source/scripts/',
    'aibox-drpy-source/template/',
    'aibox-drpy-source/vendor/'
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
    'README.md',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
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
