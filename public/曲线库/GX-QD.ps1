$ErrorActionPreference = "Stop"

$libraryDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $libraryDir "manifest.json"
$generatedScriptPath = Join-Path $libraryDir "curve-library.generated.js"
$supportedExtensions = @(".txt", ".csv", ".frd", ".tsv", ".dat")

$files = @(Get-ChildItem -LiteralPath $libraryDir -File -Recurse |
  Where-Object {
    $ext = $_.Extension.ToLowerInvariant()
    $supportedExtensions -contains $ext
  } |
  Sort-Object FullName |
  ForEach-Object {
    $relativePath = $_.FullName.Substring($libraryDir.Length).TrimStart('\') -replace '\\', '/'
    $fileText = [string](Get-Content -LiteralPath $_.FullName -Raw)
    [ordered]@{
      name = $_.BaseName
      path = $relativePath
      text = $fileText
    }
  })

$manifest = [ordered]@{
  files = @($files | ForEach-Object {
    [ordered]@{
      name = $_.name
      path = $_.path
    }
  })
}

$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
$generatedPayload = @($files | ForEach-Object {
  [ordered]@{
    name = [string]$_.name
    path = [string]$_.path
    text = [string]$_.text
  }
})
$generatedScript = "window.__EQ_CURVE_LIBRARY_DATA = " + (ConvertTo-Json -InputObject $generatedPayload -Depth 6 -Compress) + ";"
$generatedScript | Set-Content -LiteralPath $generatedScriptPath -Encoding UTF8
Write-Host "Manifest updated: $manifestPath"
Write-Host "Embedded curve library updated: $generatedScriptPath"
