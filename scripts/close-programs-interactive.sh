#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC_URL="${RPC_URL:-}"
AUTHORITY="${AUTHORITY:-}"
RECIPIENT="${RECIPIENT:-}"
SLEEP_SECONDS="${SLEEP_SECONDS:-1}"
SHOW_ALL=0

for arg in "$@"; do
  case "$arg" in
    --url=*)
      RPC_URL="${arg#*=}"
      ;;
    --authority=*)
      AUTHORITY="${arg#*=}"
      ;;
    --recipient=*)
      RECIPIENT="${arg#*=}"
      ;;
    --sleep=*)
      SLEEP_SECONDS="${arg#*=}"
      ;;
    --all)
      SHOW_ALL=1
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

show_args=(--output json)
if [[ "$SHOW_ALL" == "1" ]]; then
  show_args+=(--all)
fi
if [[ -n "$RPC_URL" ]]; then
  show_args+=(--url "$RPC_URL")
fi
if [[ -n "$AUTHORITY" ]]; then
  show_args+=(--buffer-authority "$AUTHORITY" --keypair "$AUTHORITY")
fi

buffers_json="$(solana program show --buffers "${show_args[@]}")"
programs_json="$(solana program show --programs "${show_args[@]}")"

entries_file="$(mktemp)"
python - <<'PY' >"$entries_file"
import json
import sys

raw_buffers = sys.stdin.readline().rstrip("\n")
raw_programs = sys.stdin.readline().rstrip("\n")

def load_json(raw):
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return {}

buffers_data = load_json(raw_buffers)
programs_data = load_json(raw_programs)

def find_list(obj, key):
    value = obj.get(key)
    return value if isinstance(value, list) else []

def pick(entry, keys):
    for key in keys:
        value = entry.get(key)
        if value:
            return value
    return ""

entries = []
for item in find_list(programs_data, "programs"):
    program_id = pick(item, ["programId", "program_id", "address"])
    programdata = pick(item, ["programdataAddress", "programDataAddress", "programdata", "programData"])
    lamports = pick(item, ["lamports", "balance", "accountBalance"])
    entries.append(("program", program_id, programdata, lamports))

for item in find_list(buffers_data, "buffers"):
    buffer_id = pick(item, ["bufferAddress", "address", "buffer", "bufferAccount"])
    lamports = pick(item, ["lamports", "balance", "accountBalance"])
    entries.append(("buffer", buffer_id, "", lamports))

for idx, (etype, addr, programdata, lamports) in enumerate(entries, start=1):
    print(f"{idx}\t{etype}\t{addr}\t{programdata}\t{lamports}")
PY
  <<<"$buffers_json"$'\n'"$programs_json"

if [[ ! -s "$entries_file" ]]; then
  echo "No programs or buffers found for this authority."
  exit 0
fi

echo "RPC_URL: ${RPC_URL:-<default>}"
echo "Authority: ${AUTHORITY:-<default>}"
echo "Recipient: ${RECIPIENT:-<default>}"
echo
echo "Found accounts:"
while IFS=$'\t' read -r idx etype addr programdata lamports; do
  if [[ "$etype" == "program" ]]; then
    printf "%3s) %-7s %s (programdata: %s) lamports:%s\n" "$idx" "$etype" "$addr" "${programdata:-<unknown>}" "${lamports:-<unknown>}"
  else
    printf "%3s) %-7s %s lamports:%s\n" "$idx" "$etype" "$addr" "${lamports:-<unknown>}"
  fi
done <"$entries_file"

echo
read -r -p "Enter numbers to close (comma/space separated), 'all', or 'q': " selection
if [[ "$selection" == "q" || "$selection" == "Q" ]]; then
  echo "Aborted."
  exit 0
fi

if [[ "$selection" == "all" || "$selection" == "ALL" ]]; then
  selection="$(awk -F'\t' '{print $1}' "$entries_file" | paste -sd' ' -)"
fi

read -r -p "Type 'close' to confirm: " confirm
if [[ "$confirm" != "close" ]]; then
  echo "Aborted."
  exit 0
fi

close_args=(--bypass-warning)
if [[ -n "$RPC_URL" ]]; then
  close_args+=(--url "$RPC_URL")
fi
if [[ -n "$AUTHORITY" ]]; then
  close_args+=(--authority "$AUTHORITY")
fi
if [[ -n "$RECIPIENT" ]]; then
  close_args+=(--recipient "$RECIPIENT")
fi

for idx in $selection; do
  line="$(awk -F'\t' -v idx="$idx" '$1 == idx {print}' "$entries_file")"
  if [[ -z "$line" ]]; then
    echo "Skipping unknown selection: $idx"
    continue
  fi
  IFS=$'\t' read -r _ etype addr programdata _ <<<"$line"

  if [[ "$etype" == "program" ]]; then
    echo "Closing programdata for $addr: ${programdata:-<unknown>}"
    if [[ -n "$programdata" ]]; then
      solana program close "$programdata" "${close_args[@]}" || true
      sleep "$SLEEP_SECONDS"
    fi
    echo "Closing program: $addr"
    solana program close "$addr" "${close_args[@]}" || true
  else
    echo "Closing buffer: $addr"
    solana program close "$addr" "${close_args[@]}" || true
  fi

  sleep "$SLEEP_SECONDS"
done

echo "Done."
