#!/bin/bash
# Soak SOCIAL de ponta a ponta: as 4 personas na produção por N horas, coleta
# no banco, relatório e aviso no Telegram. Pensado para rodar solto:
#   setsid nohup scripts/soak-social-run.sh 6 > /root/streampolis-soak/social-run.log 2>&1 &
# Só o relatório (rodada já feita):
#   scripts/soak-social-run.sh report <stamp> <since-ISO> <until-ISO>
set -euo pipefail
OUT=/root/streampolis-soak; mkdir -p "$OUT"
USERS="$OUT/social-users.json"
cd /root/streampolis/packages/npc
set -a; . /root/streampolis-deploy/.env; set +a

report() {
  local STAMP="$1" SINCE="$2" UNTIL="$3"
  local CID; CID=$(docker ps --filter name=streampolis_sp-api -q | head -1)
  local IDS; IDS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$USERS')).map(u=>u.userId).join(','))")
  docker exec -e DATABASE_URL="postgres://streampolis:${SP_DB_PASSWORD}@sp-db:5432/streampolis" -w /app/packages/npc "$CID" \
    node scripts/soak-social-collect.mjs --since="$SINCE" --until="$UNTIL" --users="$IDS" > "$OUT/social-$STAMP-db.json"
  docker service logs --since "$SINCE" streampolis_sp-npc 2>&1 | grep -E "\[brain\]|\[reflect\]|fadiga|arbiter" > "$OUT/social-$STAMP-worker.log" || true
  node scripts/soak-social-report.mjs --log="$OUT/social-$STAMP.jsonl" --data="$OUT/social-$STAMP-db.json" --md="$OUT/social-$STAMP.md" --send > "$OUT/social-$STAMP-report.txt" 2>&1 \
    || /opt/n8n-doctor/notify.sh "Soak social: o relatório falhou. Veja $OUT/social-$STAMP-report.txt"
}

if [ "${1:-}" = "report" ]; then report "$2" "$3" "$4"; exit 0; fi

HOURS="${1:-6}"
STAMP=$(date -u +%Y%m%d-%H%M)
SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "soak social $STAMP: $HOURS h, desde $SINCE"
/opt/n8n-doctor/notify.sh "Soak social Streampolis começou ($HOURS h): Marina, Tadeu, Lu e Caio vão visitar o Nilo e a Dalva. Relatório ao fim em $OUT/social-$STAMP.md" || true
node scripts/soak-social.mjs --users="$USERS" --hours="$HOURS" --stamp="$STAMP" --out="$OUT" || echo "driver saiu com erro $?"
UNTIL=$(date -u -d '+2 minutes' +%Y-%m-%dT%H:%M:%SZ)
sleep 60
report "$STAMP" "$SINCE" "$UNTIL"
echo "fim: $OUT/social-$STAMP.md"
