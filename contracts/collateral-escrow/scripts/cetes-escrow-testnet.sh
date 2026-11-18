#!/usr/bin/env bash
# Stage-B escrow harness for REAL Etherfuse CETES (tokenized MXN T-bill) collateral on Stellar testnet.
#
# Unlike escrow-testnet.sh (which mints a throwaway mock "COLL" token), this pledges the REAL CETES
# asset issued by the Etherfuse sandbox — SAC CC72F57Y… over CETES:GC3CW7…UPS4, home_domain
# sand.etherfuse.com. USDC is still a mock testnet token for the treasury disbursement.
#
#   cetes-escrow-testnet.sh up                 build+deploy escrow, deploy mock USDC, fund treasury,
#                                              allowlist the CETES SAC, create borrower + CETES trustline
#   cetes-escrow-testnet.sh fund-info          print the borrower address + how to onramp CETES to it
#   cetes-escrow-testnet.sh status             loan + balances (borrower CETES, treasury USDC)
#   cetes-escrow-testnet.sh deposit [coll] [principal]   borrower pledges CETES (default 100 / 5)
#   cetes-escrow-testnet.sh disburse           treasury sends USDC, loan -> Active
#   cetes-escrow-testnet.sh repay <amount>     treasury records a repayment (debt down)
#   cetes-escrow-testnet.sh close              full-repay exit (returns CETES; no engine sig needed)
#   cetes-escrow-testnet.sh release <amount>   partial collateral release (engine-attested)
#   cetes-escrow-testnet.sh reset              start a new loan id against the same deployment
#
# DEPENDENCY: the borrower must actually HOLD CETES. There is no public faucet — get it from the
# Etherfuse sandbox onramp (sandbox.etherfuse.com + API key): onramp CETES to the borrower address
# `fund-info` prints. Everything else is self-contained (friendbot XLM + a mock USDC). Testnet only.
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"

HERE="$(cd "$(dirname "$0")/.." && pwd)"
WASM="$HERE/target/wasm32v1-none/release/collateral_escrow.wasm"
ATT="$HERE/../../backend/credit-score-api/attestation.js"
STATE="$HERE/.cetes-escrow-testnet.json"
NET=testnet
SEED="$(python3 -c "print('07'*32)")"   # demo engine key seed (use Secret Manager/KMS for real)

# Real Etherfuse CETES on testnet (verified: issuer home_domain sand.etherfuse.com, SAC derived on
# Test SDF Network passphrase and confirmed on-chain).
CETES_SAC=CC72F57YTPX76HAA64JQOEGHQAPSADQWSY5DWVBR66JINPFDLNCQYHIC
CETES_ISSUER=GC3CW7EDYRTWQ635VDIGY6S4ZUF5L6TQ7AA4MWS7LEQDBLUSZXV7UPS4

jqget() { python3 -c "import json,sys;print(json.load(open('$STATE'))['$1'])"; }
inv() { stellar contract invoke --id "$1" --source "$2" --network $NET -- "${@:3}"; }
getloan() { stellar contract invoke --id "$(jqget ESCROW)" --source esc_admin --network $NET -- get_loan --loan_id "$(jqget LOAN_ID)" 2>/dev/null; }
loanget() { python3 -c "import json,sys;print(json.load(sys.stdin).get('$1',''))"; }
nextseq() { local ls; ls=$(getloan | loanget last_seq); echo $(( ${ls:-0} + 1 )); }
sign() { node -e "const a=require('$ATT');console.log(a.sign({loanId:'$(jqget LOAN_ID)',kind:'$1',seq:$2,expiry:$3,amount:$4},a.engineKeyFromSeed('$SEED')).toString('hex'))"; }

cmd="${1:-help}"
case "$cmd" in
up)
  ( cd "$HERE" && stellar contract build >/dev/null )
  ENGINE_PUB=$(node -e "const a=require('$ATT');console.log(a.publicKeyRaw(a.engineKeyFromSeed('$SEED')).toString('hex'))")
  for id in esc_admin esc_treasury esc_borrower esc_issuer; do
    stellar keys generate "$id" --network $NET --fund --overwrite >/dev/null 2>&1 || stellar keys generate "$id" --network $NET --fund >/dev/null
  done
  ADMIN=$(stellar keys address esc_admin); TREASURY=$(stellar keys address esc_treasury)
  BORROWER=$(stellar keys address esc_borrower); ISSUER=$(stellar keys address esc_issuer)
  # Mock USDC for disbursement (treasury side); CETES is the REAL collateral.
  USDC=$(stellar contract asset deploy --asset "USDC:$ISSUER" --source esc_issuer --network $NET)
  stellar tx new change-trust --source-account esc_treasury --line "USDC:$ISSUER" --network $NET >/dev/null 2>&1
  stellar tx new change-trust --source-account esc_borrower --line "USDC:$ISSUER" --network $NET >/dev/null 2>&1
  stellar contract invoke --id "$USDC" --source esc_issuer --network $NET -- mint --to "$TREASURY" --amount 1000000 >/dev/null
  # Borrower needs a CETES trustline before it can receive/hold CETES from the onramp.
  stellar tx new change-trust --source-account esc_borrower --line "CETES:$CETES_ISSUER" --network $NET >/dev/null 2>&1
  # Deploy + initialize escrow, then ALLOWLIST THE REAL CETES SAC as collateral.
  ESCROW=$(stellar contract deploy --wasm "$WASM" --source esc_admin --network $NET)
  inv "$ESCROW" esc_admin initialize --admin "$ADMIN" --engine_key "$ENGINE_PUB" --treasury "$TREASURY" --usdc "$USDC" >/dev/null
  inv "$ESCROW" esc_admin set_asset --token "$CETES_SAC" --allowed true >/dev/null
  LOAN_ID="05$(printf '05%.0s' $(seq 1 31))"
  python3 -c "import json;json.dump({'ESCROW':'$ESCROW','USDC':'$USDC','CETES':'$CETES_SAC','BORROWER':'$BORROWER','LOAN_ID':'$LOAN_ID'},open('$STATE','w'))"
  echo "deployed. escrow=$ESCROW  usdc(mock)=$USDC  collateral=CETES($CETES_SAC)"
  echo "borrower=$BORROWER  loan_id=$LOAN_ID"
  echo "explorer: https://stellar.expert/explorer/testnet/contract/$ESCROW"
  echo
  echo "NEXT: fund the borrower with CETES, then run 'deposit'. See 'fund-info'."
  ;;
fund-info)
  B=$(jqget BORROWER)
  echo "Borrower address (onramp CETES here): $B"
  echo "Its CETES trustline is already set to CETES:$CETES_ISSUER."
  echo "Get CETES from the Etherfuse sandbox (no public faucet):"
  echo "  1. sandbox.etherfuse.com -> business account -> approve KYB -> create API key"
  echo "  2. onramp CETES to $B (sandbox caps 500 MXN/quote), or swap into it"
  echo "  3. verify:  $0 status"
  ;;
status)
  echo "loan:"; getloan | python3 -m json.tool 2>/dev/null || echo "  (none yet)"
  echo "borrower CETES:"; inv "$(jqget CETES)" esc_admin balance --id "$(jqget BORROWER)"
  echo "borrower USDC:";  inv "$(jqget USDC)"  esc_admin balance --id "$(jqget BORROWER)"
  echo "treasury USDC:";  inv "$(jqget USDC)"  esc_admin balance --id "$(stellar keys address esc_treasury)"
  ;;
deposit)
  inv "$(jqget ESCROW)" esc_borrower deposit --loan_id "$(jqget LOAN_ID)" --borrower "$(jqget BORROWER)" \
    --collateral_token "$(jqget CETES)" --collateral_amount "${2:-100}" --principal "${3:-5}" --apr_bps 1400 --structure OpenEnded --term_days 0
  ;;
disburse) inv "$(jqget ESCROW)" esc_treasury disburse --loan_id "$(jqget LOAN_ID)" ;;
repay)    inv "$(jqget ESCROW)" esc_treasury record_repayment --loan_id "$(jqget LOAN_ID)" --amount "$2" ;;
close)    inv "$(jqget ESCROW)" esc_borrower close --loan_id "$(jqget LOAN_ID)" ;;
release)
  seq=$(nextseq); exp=$(( $(date +%s) + 3600 )); sig=$(sign release "$seq" "$exp" "$2")
  inv "$(jqget ESCROW)" esc_borrower release --loan_id "$(jqget LOAN_ID)" --amount "$2" --seq "$seq" --expiry "$exp" --signature "$sig"
  ;;
reset)
  python3 -c "import json,random;d=json.load(open('$STATE'));d['LOAN_ID']=''.join(random.choice('0123456789abcdef') for _ in range(64));json.dump(d,open('$STATE','w'));print('new loan_id',d['LOAN_ID'])"
  ;;
*) sed -n '2,20p' "$0" ;;
esac
