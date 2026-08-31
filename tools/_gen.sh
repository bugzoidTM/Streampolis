#!/bin/bash
# gera uma imagem pelo worker de imagem da Cloudflare
out="$1"; shift
prompt="$*"
python3 - "$out" "$prompt" <<'PY'
import json, sys, urllib.request, base64
out, prompt = sys.argv[1], sys.argv[2]
req = urllib.request.Request(
    "https://imagem.contato-66e.workers.dev/v1/images/generations",
    data=json.dumps({"prompt": prompt, "model": "@cf/black-forest-labs/flux-1-schnell",
                     "num_inference_steps": 8, "ratio": "16:9"}).encode(),
    headers={"content-type": "application/json", "authorization": "Bearer 0001"})
try:
    body = json.load(urllib.request.urlopen(req, timeout=180))
except Exception as e:
    print("ERRO", e); sys.exit(1)
item = (body.get("data") or [{}])[0]
b64 = item.get("b64_json") or item.get("image")
if not b64:
    print("SEM IMAGEM:", json.dumps(body)[:400]); sys.exit(1)
open(out, "wb").write(base64.b64decode(b64))
print("ok", out)
PY
