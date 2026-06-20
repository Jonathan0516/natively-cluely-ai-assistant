#!/usr/bin/env bash
# End-to-end backend smoke for the LLM gateway (phases 1-4a).
# Run from anywhere: bash backend/scripts/smoke_gateway.sh
set -uo pipefail

# cd to backend/ (this script lives in backend/scripts/)
cd "$(dirname "$0")/.." || exit 1

PORT=8000
BASE="http://localhost:${PORT}"
TEST_USER_ID="f4e48046-3c71-438d-811e-2eeb5c1572af"
TEST_USER_PHONE="13800138001"

# --- start backend ---
lsof -ti:${PORT} | xargs kill 2>/dev/null || true
uv run uvicorn app.main:app --app-dir src --port ${PORT} >/tmp/smoke.log 2>&1 &
UVPID=$!
cleanup() { kill "${UVPID}" 2>/dev/null || true; }
trap cleanup EXIT

echo "waiting for backend..."
until curl -sf "${BASE}/health" >/dev/null 2>&1; do sleep 0.5; done
echo "backend up."

# --- mint a test JWT for an existing user ---
TOKEN=$(PYTHONPATH=src uv run python - <<PY
from app.config import get_settings
from app.services.jwt_service import JwtService
s = get_settings()
j = JwtService(secret=s.jwt_secret, algorithm=s.jwt_algorithm,
               access_ttl=s.jwt_access_ttl_seconds, refresh_ttl=s.jwt_refresh_ttl_seconds)
print(j.issue("${TEST_USER_ID}", "${TEST_USER_PHONE}").access_token)
PY
)
AUTH="Authorization: Bearer ${TOKEN}"
JSON="content-type: application/json"

echo
echo "========== HTTP gateway =========="
echo "1) unauth /llm/quota -> expect 401:"
curl -s -o /dev/null -w "   HTTP %{http_code}\n" "${BASE}/llm/quota"

echo "2) /llm/quota:"
curl -s -H "${AUTH}" "${BASE}/llm/quota"; echo

echo "3) /llm/models:"
curl -s -H "${AUTH}" "${BASE}/llm/models"; echo

echo "4) /llm/json (answer-fast):"
curl -s -H "${AUTH}" -H "${JSON}" \
  -d '{"model":"answer-fast","messages":[{"role":"user","content":"hi"}]}' \
  "${BASE}/llm/json"; echo

echo "5) /llm/chat (SSE stream):"
curl -s -N -H "${AUTH}" -H "${JSON}" \
  -d '{"model":"answer-fast","messages":[{"role":"user","content":"Say hi in 3 words"}]}' \
  "${BASE}/llm/chat"

echo "6) /llm/embeddings (expect dim 768):"
curl -s -H "${AUTH}" -H "${JSON}" \
  -d '{"texts":["hello world","second text"]}' "${BASE}/llm/embeddings" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('   dim',d['dim'],'vectors',len(d['embeddings']),'model',d['model'])"

echo "7) /llm/json unknown model -> expect 400:"
curl -s -o /dev/null -w "   HTTP %{http_code}\n" -H "${AUTH}" -H "${JSON}" \
  -d '{"model":"nope","messages":[{"role":"user","content":"x"}]}' "${BASE}/llm/json"

echo
echo "========== WS STT =========="
echo "8) WS /llm/stt: connect + send 1s audio (expect: no 4401/4029, stays open):"
PYTHONPATH=src TOKEN="${TOKEN}" PORT="${PORT}" uv run python - <<'PY'
import asyncio, os, math, struct, websockets
async def main():
    token = os.environ["TOKEN"]; port = os.environ["PORT"]
    url = f"ws://localhost:{port}/llm/stt?token={token}&sample_rate=16000&channels=1&model=nova-3"
    try:
        async with websockets.connect(url) as ws:
            frames = bytearray()
            for n in range(16000):  # 1s of a 220Hz tone
                frames += struct.pack('<h', int(3000*math.sin(2*math.pi*220*n/16000)))
            await ws.send(bytes(frames))
            print("   connected + sent 1s audio OK")
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=3.0)
                print("   transcript:", msg[:120])
            except asyncio.TimeoutError:
                print("   (no transcript for synthetic tone — expected)")
    except Exception as e:
        print("   WS error:", type(e).__name__, str(e)[:160])
asyncio.run(main())
PY

echo
echo "Done. Check usage_events in Supabase for chat/json/embeddings/stt rows."
