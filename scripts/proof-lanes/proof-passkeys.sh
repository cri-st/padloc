#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# npm lifecycle shells may restore an ambient machine PATH. Keep every nested
# proof process on the Node runtime that launched this proof.
if [[ -n "${npm_node_execpath:-}" ]]; then
  export PATH="$(dirname "$npm_node_execpath"):$PATH"
  hash -r
fi
npm_command=(npm)
if [[ -n "${npm_node_execpath:-}" && -n "${npm_execpath:-}" ]]; then
  npm_command=("$npm_node_execpath" "$npm_execpath")
fi

search_lines() {
  if command -v rg >/dev/null 2>&1; then
    rg -n "$@"
  else
    grep -REn "$@"
  fi
}

filter_lines_out() {
  if command -v rg >/dev/null 2>&1; then
    rg -v "$1"
  else
    grep -Ev "$1"
  fi
}

mode="${1:-all}"
if [[ "$mode" == "--help" || "$mode" == "-h" ]]; then
  cat <<'EOF'
Usage:
  npm run proof:passkeys:pr
  npm run proof:passkeys:macos-contract
  npm run proof:passkeys
  PADLOC_NATIVE_SYSTEM_E2E=1 npm run proof:passkeys:system

proof:passkeys:pr is the unattended Linux PR lane. It runs the shared-RP,
extension, typecheck, production-artifact restoration, runtime-contract, and
redaction gates. It intentionally does not require Xcode.

proof:passkeys:macos-contract runs the native codec/store/broker contract
against the same shared verifier. proof:passkeys aggregates both on macOS.

proof:passkeys:system additionally requires an installed signed macOS provider
and supervises only the protected device-owner sheets. Install/update it with:
  npm run passkeys:native:install
EOF
  exit 0
fi

artifact_before="$(mktemp -d /tmp/ch5-passkey-artifact.XXXXXX)"
artifact_existed=0
if [[ -d packages/extension/dist ]]; then
  artifact_existed=1
  cp -R packages/extension/dist "$artifact_before/dist"
fi
restore_artifact() {
  rm -rf packages/extension/dist
  if [[ "$artifact_existed" == "1" ]]; then cp -R "$artifact_before/dist" packages/extension/dist; fi
  rm -rf "$artifact_before"
}
trap restore_artifact EXIT

if [[ "$mode" != "all" && "$mode" != "--pr" && "$mode" != "--macos-contract" ]]; then
  echo "unknown passkey proof mode: $mode" >&2
  exit 2
fi

if [[ "$mode" == "--macos-contract" ]]; then
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "native passkey contract requires macOS" >&2
    exit 2
  fi

  echo "passkey proof: native codec, store, broker, and shared-verifier contract"
  xcodebuild test -project packages/macos/CH5AuthPasskeyProvider.xcodeproj \
    -scheme CH5AuthHost -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO \
    SWIFT_ACTIVE_COMPILATION_CONDITIONS='$(inherited) CH5_PASSKEY_TEST_VERIFICATION_INJECTION'

  echo "passkey proof: native diagnostic secrecy"
  diagnostic_matches="$(search_lines '(logger|console)\.(notice|error|log).*?(clientDataHash|credentialID|userHandle|userName|rawRepresentation|privateKey|password|challenge)' \
    packages/macos || true)"
  approved_fingerprint_log='^packages/macos/CredentialProvider/CredentialProviderViewController\.swift:[0-9]+:[[:space:]]+logger\.notice\("(registration|assertion) credential fingerprint=\\\(self\.credentialFingerprint\(record\.credentialID\), privacy: \.public\)"\)$'
  unsafe_diagnostic_matches="$(printf '%s\n' "$diagnostic_matches" | filter_lines_out "$approved_fingerprint_log" || true)"
  if [[ -n "$unsafe_diagnostic_matches" ]]; then
    printf '%s\n' "$unsafe_diagnostic_matches"
    echo "passkey diagnostic may expose sensitive ceremony material" >&2
    exit 1
  fi

  git --no-pager diff --check -- packages/macos scripts/proof-lanes/proof-passkeys.sh
  echo "passkey proof: macOS contract passed"
  exit 0
fi

echo "passkey proof: shared verifier and RP server"
"${npm_command[@]}" --prefix packages/extension run test:passkey-rp

echo "passkey proof: extension unit and integration suite"
TS_NODE_TRANSPILE_ONLY=1 TS_NODE_COMPILER_OPTIONS='{"module":"commonjs"}' \
  node packages/extension/test/passkey-rp/run-tests.cjs packages/extension/test

echo "passkey proof: extension controlled RP, restart, and five-identity E2E"
"${npm_command[@]}" --prefix packages/extension run test:passkey-rp:extension

echo "passkey proof: extension typecheck"
./node_modules/.bin/tsc --noEmit --skipLibCheck -p packages/extension/tsconfig.json

if [[ "$mode" != "--pr" ]]; then
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "native passkey contract requires macOS; run proof:passkeys:pr on Linux" >&2
    exit 2
  fi
  echo "passkey proof: native codec, store, broker, and shared-verifier contract"
  xcodebuild test -quiet -project packages/macos/CH5AuthPasskeyProvider.xcodeproj \
    -scheme CH5AuthHost -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO
fi

echo "passkey proof: worker log redaction and runtime target contract"
"${npm_command[@]}" --prefix packages/worker run test:logging-redaction
"${npm_command[@]}" run runtime-config:check

echo "passkey proof: changed-source diagnostic secrecy"
diagnostic_matches="$(search_lines '(logger|console)\.(notice|error|log).*?(clientDataHash|credentialID|userHandle|userName|rawRepresentation|privateKey|password|challenge)' \
  packages/macos packages/extension/src packages/extension/test/passkey-rp packages/worker/src || true)"
approved_fingerprint_log='^packages/macos/CredentialProvider/CredentialProviderViewController\.swift:[0-9]+:[[:space:]]+logger\.notice\("(registration|assertion) credential fingerprint=\\\(self\.credentialFingerprint\(record\.credentialID\), privacy: \.public\)"\)$'
unsafe_diagnostic_matches="$(printf '%s\n' "$diagnostic_matches" | filter_lines_out "$approved_fingerprint_log" || true)"
if [[ -n "$unsafe_diagnostic_matches" ]]; then
  printf '%s\n' "$unsafe_diagnostic_matches"
  echo "passkey diagnostic may expose sensitive ceremony material" >&2
  exit 1
fi

echo "passkey proof: production extension artifact restoration"
PL_SERVER_URL=https://api.example.com PL_BUILD_ENV=production "${npm_command[@]}" run web-extension:build >/dev/null
test -f packages/extension/dist/manifest.json
if find packages/extension/dist -name '*.map' -print -quit | grep -q .; then
  echo "production extension build contains source maps" >&2
  exit 1
fi
if command -v rg >/dev/null 2>&1; then
  rg -q 'https://api-pad\.ch5\.me' packages/extension/dist
else
  grep -RqE 'https://api-pad\.ch5\.me' packages/extension/dist
fi

git --no-pager diff --check -- packages/core packages/extension packages/macos packages/worker \
  docs/passkey-provider-test-plan.md docs/passkey-provider-native-handoff.md \
  scripts/install-native-passkey-provider.sh scripts/proof-lanes/proof-passkeys.sh
echo "passkey proof: deterministic lanes passed"
