#!/usr/bin/env bash
# ==============================================================
# Sai Krishna Graphics & Offset - UPI Direct Payment Hit Trigger
# ==============================================================
# Usage:
#   ./test-payment.sh
#   ./test-payment.sh <ORDER_ID> <AMOUNT>
# ==============================================================

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
ORDER_ID="$1"
AMOUNT="$2"

echo "💳 Triggering Direct UPI Payment Hit to server at $SERVER_URL..."

if [ -n "$ORDER_ID" ]; then
  PAYLOAD="{\"orderId\":\"$ORDER_ID\""
  if [ -n "$AMOUNT" ]; then
    PAYLOAD="$PAYLOAD,\"amount\":$AMOUNT"
  fi
  PAYLOAD="$PAYLOAD}"
else
  PAYLOAD="{\"notes\":\"Direct terminal payment trigger\"}"
fi

RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X POST "$SERVER_URL/api/payment/hit" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

BODY=$(echo "$RESPONSE" | sed -e '$d')
STATUS=$(echo "$RESPONSE" | tail -n1 | cut -d':' -f2)

if [ "$STATUS" = "200" ]; then
  echo "✅ Payment Verified Successfully!"
  echo "$BODY"
else
  echo "⚠️ Server returned HTTP $STATUS:"
  echo "$BODY"
  echo "Tip: Make sure the server is running on $SERVER_URL or provide SERVER_URL environment variable."
fi
