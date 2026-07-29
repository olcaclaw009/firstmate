#!/usr/bin/env bash
# Behavior tests for OMP as a verified primary-only Firstmate runtime.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TMP_ROOT=$(fm_test_tmproot fm-omp-primary)
BASE_PATH=${FM_TEST_BASE_PATH:-/usr/bin:/bin:/usr/sbin:/sbin}

make_omp_ancestry_fakebin() {
  local dir=$1 fakebin
  fakebin=$(fm_fakebin "$dir")
  cat > "$fakebin/ps" <<'SH'
#!/usr/bin/env bash
set -u
field=
pid=
prev=
for arg in "$@"; do
  [ "$prev" = -o ] && field=$arg
  [ "$prev" = -p ] && pid=$arg
  prev=$arg
done
omp_pid=${FM_FAKE_OMP_PID:-4242}
case "$field:$pid" in
  comm=:$omp_pid) printf '/opt/homebrew/bin/omp\n' ;;
  args=:$omp_pid) printf 'omp\n' ;;
  ppid=:$omp_pid) printf '1\n' ;;
  comm=:*) printf -- '-zsh\n' ;;
  args=:*) printf -- '-zsh\n' ;;
  ppid=:*) printf '%s\n' "$omp_pid" ;;
esac
SH
  chmod +x "$fakebin/ps"
  printf '%s\n' "$fakebin"
}

without_harness_markers() {
  env -u OMPCODE -u CLAUDECODE -u PI_CODING_AGENT -u FM_PI_HARNESS -u GROK_AGENT "$@"
}

test_omp_env_marker_precedes_claudecode() {
  local out
  out=$(OMPCODE=1 CLAUDECODE=1 PI_CODING_AGENT=true "$ROOT/bin/fm-harness.sh")
  [ "$out" = omp ] || fail "OMPCODE did not take precedence over CLAUDECODE and Pi markers: $out"

  out=$(env -u OMPCODE CLAUDECODE=1 "$ROOT/bin/fm-harness.sh")
  [ "$out" = claude ] || fail "CLAUDECODE-only detection changed: $out"
  pass "fm-harness: OMPCODE wins over Claude compatibility markers"
}

test_omp_ancestry_tolerates_leading_dash_shell() {
  local fakebin out err cfg
  fakebin=$(make_omp_ancestry_fakebin "$TMP_ROOT/ancestry")
  cfg="$TMP_ROOT/empty-config"
  mkdir -p "$cfg"
  err="$TMP_ROOT/ancestry.err"
  out=$(without_harness_markers PATH="$fakebin:$BASE_PATH" FM_CONFIG_OVERRIDE="$cfg" \
    "$ROOT/bin/fm-harness.sh" 2>"$err")
  [ "$out" = omp ] || fail "OMP ancestry detection returned '$out'"
  assert_not_contains "$(cat "$err")" "basename" "leading-dash shell comm leaked a basename usage error"
  pass "fm-harness: OMP ancestry detection handles a -zsh parent shell"
}

test_omp_session_lock_identity() {
  local fakebin home out err lock_pid sleep_pid
  fakebin=$(make_omp_ancestry_fakebin "$TMP_ROOT/lock")
  home="$TMP_ROOT/home"
  mkdir -p "$home/state"
  err="$TMP_ROOT/lock.err"

  sleep 60 &
  sleep_pid=$!
  out=$(without_harness_markers PATH="$fakebin:$BASE_PATH" FM_FAKE_OMP_PID="$sleep_pid" FM_HOME="$home" \
    "$ROOT/bin/fm-lock.sh" 2>"$err") \
    || { kill "$sleep_pid" 2>/dev/null || true; wait "$sleep_pid" 2>/dev/null || true; fail "fm-lock did not acquire from OMP ancestry: $(cat "$err")"; }
  assert_contains "$out" "lock acquired: harness pid $sleep_pid" "fm-lock did not record the OMP harness ancestor"
  assert_not_contains "$(cat "$err")" "basename" "fm-lock acquire printed a basename usage error"

  lock_pid=$(cat "$home/state/.lock")
  [ "$lock_pid" = "$sleep_pid" ] || { kill "$sleep_pid" 2>/dev/null || true; wait "$sleep_pid" 2>/dev/null || true; fail "fm-lock wrote '$lock_pid', expected $sleep_pid"; }
  out=$(without_harness_markers PATH="$fakebin:$BASE_PATH" FM_FAKE_OMP_PID="$sleep_pid" FM_HOME="$home" \
    "$ROOT/bin/fm-lock.sh" status 2>"$err")
  assert_contains "$out" "lock: held by live harness pid $sleep_pid" "fm-lock did not recognize OMP as a live lock holder"
  kill "$sleep_pid" 2>/dev/null || true
  wait "$sleep_pid" 2>/dev/null || true
  assert_not_contains "$(cat "$err")" "basename" "fm-lock status printed a basename usage error"
  pass "fm-lock: OMP is a recognized live session-lock holder"
}

test_omp_extension_contract() {
  local name shim entry count watch
  [ -d "$ROOT/.omp/extensions" ] || fail "OMP extension discovery directory is missing"
  [ -L "$ROOT/.omp/extensions" ] && fail "OMP extension discovery must not be a directory symlink"
  for name in fm-primary-turnend-guard.ts fm-primary-pi-watch.ts; do
    [ -f "$ROOT/.omp/extensions/$name" ] || fail "OMP extension entry for $name is missing"
    [ -L "$ROOT/.omp/extensions/$name" ] && \
      fail "OMP extension entry for $name must be a regular file so auto-discovery sees it"
    shim=$(cat "$ROOT/.omp/extensions/$name")
    assert_contains "$shim" "import extension from \"../../.pi/extensions/$name\"" \
      "OMP extension entry for $name does not delegate to the shared Pi implementation"
    assert_contains "$shim" 'extension(pi, { runtime: "omp" })' \
      "OMP extension entry for $name does not tell the shared implementation it is running on OMP"
  done
  count=0
  for entry in "$ROOT/.omp/extensions"/*; do
    [ -e "$entry" ] || continue
    count=$((count + 1))
  done
  [ "$count" -eq 2 ] || \
    fail "OMP extension directory exposes $count entries, expected only the two supervision extensions"

  # OMP sets OMPCODE only in the shells it spawns, never in its own extension
  # host, so in-process detection must come from the discovery entry argument.
  for name in fm-primary-turnend-guard.ts fm-primary-pi-watch.ts; do
    watch=$(cat "$ROOT/.pi/extensions/$name")
    assert_contains "$watch" 'options.runtime === "omp"' \
      "the shared $name extension does not take the OMP runtime from its discovery entry"
    assert_not_contains "$watch" "process.env.OMPCODE" \
      "the shared $name extension detects OMP through an environment marker OMP does not set in its extension host"
  done
  pass "OMP exposes exactly the two shared supervision extensions as discoverable files"
}

test_omp_extensions_load() {
  local home out status name marker source expected
  if ! command -v omp >/dev/null 2>&1; then
    echo "skip: omp not found for OMP extension-load smoke"
    return 0
  fi
  home="$TMP_ROOT/extension-load-home"
  mkdir -p "$home/config" "$home/state"
  out=$(cd "$ROOT" && \
    FM_HOME="$home" FM_STATE_OVERRIDE="$home/state" FM_ROOT_OVERRIDE="$ROOT" \
    omp -p --max-time=30 --no-session --no-tools "reply exactly OMP_EXT_OK" 2>&1)
  status=$?
  expect_code 0 "$status" "OMP extension-load smoke should succeed: $out"
  assert_contains "$out" "OMP_EXT_OK" "OMP extension-load smoke did not complete the prompt"
  assert_not_contains "$out" "Failed to load extension" "OMP reported an extension load failure"
  assert_not_contains "$out" "Extension error" "OMP reported an extension runtime error"
  assert_present "$home/state/.pi-turnend-extension-loaded" \
    "OMP auto-discovery did not load the shared turn-end extension"
  assert_present "$home/state/.pi-watch-extension-loaded" \
    "OMP auto-discovery did not load the shared watcher extension"

  # bin/fm-session-start.sh compares the marker against the shared .pi file, so
  # the discovery entry must not change which file the extension hashes.
  for name in turnend:fm-primary-turnend-guard watch:fm-primary-pi-watch; do
    marker="$home/state/.pi-${name%%:*}-extension-loaded"
    source="$ROOT/.pi/extensions/${name#*:}.ts"
    if command -v shasum >/dev/null 2>&1; then
      expected="sha256:$(shasum -a 256 "$source" | awk '{print $1}')"
    else
      expected="sha256:$(sha256sum "$source" | awk '{print $1}')"
    fi
    [ "$(sed -n '1p' "$marker")" = "$expected" ] || \
      fail "OMP marker for ${name#*:} does not carry the shared .pi extension version"
  done
  pass "OMP auto-discovers both shared supervision extensions with zero load errors"
}

test_omp_env_marker_precedes_claudecode
test_omp_ancestry_tolerates_leading_dash_shell
test_omp_session_lock_identity
test_omp_extension_contract
test_omp_extensions_load
