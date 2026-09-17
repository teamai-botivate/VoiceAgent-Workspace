# Merge only the ElevenLabs deployment settings, preserving Gemini and other keys.
# Usage: awk -f deploy/merge-elevenlabs-env.awk private-update.env .env
function setting_key(line, parts) {
  split(line, parts, "=")
  return parts[1]
}
FNR == NR {
  if ($0 ~ /^(ELEVENLABS_API_KEY|ELEVENLABS_AGENT_ID|ELEVENLABS_WEBHOOK_SECRET|PUBLIC_BASE_URL)=/) {
    key = setting_key($0)
    updates[key] = $0
  }
  next
}
{
  key = setting_key($0)
  if (key in updates) {
    print updates[key]
    applied[key] = 1
  } else {
    print
  }
}
END {
  for (key in updates) {
    if (!(key in applied)) print updates[key]
  }
}
