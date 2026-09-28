#!/usr/bin/env bash
# Drives bin/fm-tool-update-check.sh the way the watcher does (timeout $FM_CHECK_TIMEOUT bash <check>)
# against a throwaway FM_HOME with synthetic tools. Never touches real fleet state.
set -u
CHECK="$1"; LAB=$(mktemp -d "${TMPDIR:-/tmp}/fm-lab.XXXXXX"); trap 'rm -rf "$LAB"' EXIT
mkdir -p "$LAB/home/state" "$LAB/home/config" "$LAB/bin"
mk() { printf '#!/usr/bin/env bash\n%s\n' "$2" > "$LAB/bin/$1"; chmod +x "$LAB/bin/$1"; }
# Same perl bound the watcher uses when timeout/gtimeout are absent (bin/fm-watch.sh run_check_process); exit 124 = killed by watcher bound.
PERLBOUND='my $t = shift; my $pid = fork; if (!$pid) { setpgrp(0,0); exec @ARGV } local $SIG{ALRM} = sub { kill "TERM", -$pid; select undef,undef,undef,0.2; kill "KILL", -$pid; waitpid $pid,0; exit 124 }; alarm $t; waitpid $pid,0; exit($? >> 8)'
run() { # label, config json, env...
  local label=$1 cfg=$2; shift 2
  printf '%s\n' "$cfg" > "$LAB/home/config/watched-tools.json"; rm -f "$LAB/home/state/"*
  local s e rc=0; s=$(perl -MTime::HiRes=time -e 'printf "%.2f", time')
  out=$(env "$@" FM_HOME="$LAB/home" PATH="$LAB/bin:$PATH" FM_TOOL_UPDATE_INTERVAL=0 perl -e "$PERLBOUND" "${FM_CHECK_TIMEOUT:-30}" bash "$CHECK" 2>&1) || rc=$?
  e=$(perl -MTime::HiRes=time -e 'printf "%.2f", time')
  printf '== %s\n   exit=%s wall=%.2fs\n   output: %s\n' "$label" "$rc" "$(echo "$e - $s" | bc)" "${out:-<silent>}"
}
mk fast-a-fx "echo 'fast-a 1.2.3'"; mk fast-b-fx "echo 'fast-b 1.2.3'"; mk fast-c-fx "echo 'fast-c 1.2.3'"
mk hung-fx "trap '' TERM; sleep 100"
FIVE='{"tools":[{"name":"a","command":"fast-a-fx"},{"name":"b","command":"fast-b-fx"},{"name":"c","command":"fast-c-fx"}]}'
for i in 1 2 3 4 5; do run "S1 three fast tools, BUDGET_SECS=1 (run $i)" "$FIVE" FM_TOOL_UPDATE_BUDGET_SECS=1 FM_CHECK_TIMEOUT=30; sleep 0.37; done
run "S2 default budget, three fast tools" "$FIVE" FM_CHECK_TIMEOUT=30
run "S3 hung tool then fast tool, probe 1s, budget 2s" '{"tools":[{"name":"hung","command":"hung-fx"},{"name":"a","command":"fast-a-fx"}]}' FM_TOOL_UPDATE_PROBE_SECS=1 FM_TOOL_UPDATE_BUDGET_SECS=2 FM_CHECK_TIMEOUT=30
export FM_CHECK_TIMEOUT=30
run "S4 adversarial: budget 60 cut, watcher timeout 30, tools hang TERM-ignoring (must finish <30s and print)" \
  '{"tools":[{"name":"h1","command":"hung-fx"},{"name":"h2","command":"hung-fx"},{"name":"h3","command":"hung-fx"},{"name":"h4","command":"hung-fx"},{"name":"h5","command":"hung-fx"},{"name":"h6","command":"hung-fx"},{"name":"h7","command":"hung-fx"},{"name":"h8","command":"hung-fx"}]}' \
  FM_TOOL_UPDATE_BUDGET_SECS=60 FM_TOOL_UPDATE_PROBE_SECS=5
export FM_CHECK_TIMEOUT=10
run "S5 adversarial: tight watcher timeout 10, budget 20 cut, hung tools (must finish <10s and print)" \
  '{"tools":[{"name":"h1","command":"hung-fx"},{"name":"h2","command":"hung-fx"},{"name":"h3","command":"hung-fx"},{"name":"h4","command":"hung-fx"}]}' \
  FM_TOOL_UPDATE_PROBE_SECS=5
