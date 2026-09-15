#!/bin/bash
# Soak test de autonomia: coleta no container da API (banco de produção),
# log do worker no host, relatório com juiz LLM, envio ao Telegram.
#   soak-run.sh <since-ISO> [--send]
set -euo pipefail
SINCE="${1:?since ISO}"; SEND="${2:-}"
OUT=/root/streampolis-soak; mkdir -p "$OUT"
STAMP=$(date -u +%Y%m%d-%H%M)
set -a; . /root/streampolis-deploy/.env; set +a
CID=$(docker ps --filter name=streampolis_sp-api -q | head -1)
docker exec -e DATABASE_URL="postgres://streampolis:${SP_DB_PASSWORD}@sp-db:5432/streampolis" -e WORLD_DAY_MINUTES=120 \
  -w /app/packages/npc "$CID" node scripts/soak-collect.mjs --since="$SINCE" > "$OUT/coleta-$STAMP.json"
docker service logs --since "$SINCE" streampolis_sp-npc 2>&1 | grep -E "\[brain\]|\[reflect\]|\[main\] (troca|entrando|saiu)" > "$OUT/worker-$STAMP.log" || true
cd /root/streampolis/packages/npc
node scripts/soak-report.mjs --data="$OUT/coleta-$STAMP.json" --log="$OUT/worker-$STAMP.log" $SEND > "$OUT/relatorio-$STAMP.txt" 2>&1 || { /opt/n8n-doctor/notify.sh "Soak test: o relatório falhou. Veja $OUT/relatorio-$STAMP.txt"; exit 1; }
