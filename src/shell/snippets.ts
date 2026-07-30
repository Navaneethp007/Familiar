/**
 * The code that goes into your shell profile.
 *
 * Rules these snippets obey, in order of importance:
 *
 * 1. **Never break the prompt.** A broken hook is an annoyance; a broken
 *    prompt can leave you without a working shell to fix it from. Everything
 *    is wrapped and every failure is swallowed.
 * 2. **Never change what the shell reports.** `$?` and `$LASTEXITCODE` are
 *    captured first and restored before control goes back, so anything else in
 *    your prompt still sees the real exit code.
 * 3. **Never launch a program.** Only shell builtins. This runs after every
 *    command you type; it has to be free.
 * 4. **Log only check-shaped commands.** Not a copy of your shell history.
 *
 * The matching here is deliberately loose. Precise classification happens in
 * adapters/terminal.ts, where it can be tested and changed without asking you
 * to touch your profile again.
 */

export const BLOCK_START = '# >>> familiar >>>';
export const BLOCK_END = '# <<< familiar <<<';

/**
 * Coarse gate, shared in spirit by both shells. Anything matching gets logged
 * and sorted out later; anything else is never written down at all.
 */
export const SHELL_MATCH_WORDS = [
  'test',
  'tests',
  'build',
  'typecheck',
  'type-check',
  'lint',
  'tsc',
  'vitest',
  'jest',
  'mocha',
  'pytest',
  'rspec',
  'phpunit',
  'cargo',
  'dotnet',
  'mypy',
  'pyright',
  'eslint',
  'ruff',
  'gradle',
  'make',
] as const;

const POWERSHELL_PATTERN = SHELL_MATCH_WORDS.join('|');
/** bash has no regex in `case`, so the same words become a glob alternation. */
const BASH_GLOB = SHELL_MATCH_WORDS.map((word) => `*${word}*`).join('|');

export function powershellSnippet(): string {
  return `${BLOCK_START}
# Familiar — records check outcomes so your creature can see what you fixed.
# Remove with: familiar shell uninstall
if (-not $global:__familiarInstalled) {
  $global:__familiarInstalled = $true
  $global:__familiarLastId = -1
  $global:__familiarInnerPrompt = $function:prompt

  function global:__familiarLog([int]$ExitCode, [string]$Command) {
    try {
      if ([string]::IsNullOrWhiteSpace($Command)) { return }
      if ($Command -notmatch '(?i)\\b(${POWERSHELL_PATTERN})\\b') { return }

      $home_ = if ($env:FAMILIAR_HOME) { $env:FAMILIAR_HOME } else { Join-Path $env:USERPROFILE '.familiar' }
      if (-not (Test-Path -LiteralPath $home_)) { return }

      $agent = '-'
      if ($env:CLAUDECODE) { $agent = 'claude-code' }
      elseif ($env:CURSOR_TRACE_ID -or $env:CURSOR_SESSION_ID) { $agent = 'cursor' }

      $clean = ($Command -replace '[\\r\\n\\t]', ' ').Trim()
      $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      $cwd = (Get-Location).Path -replace '\\\\', '/'
      $line = "$stamp\`t$ExitCode\`t$agent\`t$cwd\`t$clean"

      Add-Content -LiteralPath (Join-Path $home_ 'shell.log') -Value $line -Encoding utf8 -ErrorAction SilentlyContinue
    } catch { }
  }

  function global:prompt {
    # Captured first: everything below must leave these untouched.
    $__familiarOk = $?
    $__familiarCode = $LASTEXITCODE
    try {
      $h = Get-History -Count 1 -ErrorAction SilentlyContinue
      if ($h -and $h.Id -ne $global:__familiarLastId) {
        $global:__familiarLastId = $h.Id
        # $LASTEXITCODE is only set by native executables; fall back to $? so a
        # failing cmdlet is not silently recorded as a success.
        $code = if ($null -ne $__familiarCode) { $__familiarCode } elseif ($__familiarOk) { 0 } else { 1 }
        __familiarLog $code $h.CommandLine
      }
    } catch { }
    $global:LASTEXITCODE = $__familiarCode
    & $global:__familiarInnerPrompt
  }
}
${BLOCK_END}`;
}

export function bashSnippet(): string {
  return `${BLOCK_START}
# Familiar — records check outcomes so your creature can see what you fixed.
# Remove with: familiar shell uninstall
__familiar_log() {
  local __code="$1"; shift
  local __cmd="$*"
  case "$__cmd" in
    *--watch*|*nodemon*) return 0 ;;
  esac
  case "$__cmd" in
    ${BASH_GLOB}) ;;
    *) return 0 ;;
  esac
  local __home="\${FAMILIAR_HOME:-$HOME/.familiar}"
  # A Windows-style override reaches us with backslashes, which bash reads as
  # escapes — the directory test would fail and nothing would ever be logged.
  __home="\${__home//\\\\//}"
  [ -d "$__home" ] || return 0
  local __agent='-'
  [ -n "\${CLAUDECODE:-}" ] && __agent='claude-code'
  [ -n "\${CURSOR_TRACE_ID:-}" ] && __agent='cursor'
  __cmd="\${__cmd//[$'\\t\\r\\n']/ }"
  # Millisecond resolution matters: events are deduplicated by line content, so
  # two identical commands inside the same second would collapse into one and
  # undercount how many attempts a fix actually took. EPOCHREALTIME is bash 5+;
  # older shells fall back to seconds and accept that.
  local __ts
  if [ -n "\${EPOCHREALTIME:-}" ]; then
    __ts="\${EPOCHREALTIME/[.,]/}"
    __ts="\${__ts:0:13}"
  else
    __ts="$(( $(date +%s) * 1000 ))"
  fi
  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' \\
    "$__ts" "$__code" "$__agent" "$PWD" "$__cmd" \\
    >> "$__home/shell.log" 2>/dev/null
  return 0
}

__familiar_report() {
  # Captured first, returned last: the rest of PROMPT_COMMAND must still see
  # the real exit status of the command you actually ran.
  local __code=$?
  local __entry __num __cmd
  __entry="$(HISTTIMEFORMAT='' history 1 2>/dev/null)"
  # history prints "  123  the command". Trim, take the leading digits as the
  # entry number, then trim again to leave the command itself.
  __entry="\${__entry#"\${__entry%%[![:space:]]*}"}"
  __num="\${__entry%%[![:digit:]]*}"
  __cmd="\${__entry#"$__num"}"
  __cmd="\${__cmd#"\${__cmd%%[![:space:]]*}"}"
  # The number guard stops a bare Enter, which does not add to history, from
  # re-logging the previous command every time you press it.
  if [ -n "$__num" ] && [ "$__num" != "\${__FAMILIAR_LAST_HIST:-}" ]; then
    __FAMILIAR_LAST_HIST="$__num"
    __familiar_log "$__code" "$__cmd" 2>/dev/null
  fi
  return $__code
}

case "\${PROMPT_COMMAND:-}" in
  *__familiar_report*) ;;
  *) PROMPT_COMMAND="__familiar_report\${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac
${BLOCK_END}`;
}
