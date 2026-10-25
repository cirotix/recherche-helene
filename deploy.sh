#!/bin/sh
# Déploie le worker Cloudflare et branche la carte dessus. Lancer depuis le dossier du dépôt.
set -e
W="npx -y wrangler@4"
$W login
if grep -q KV_ID wrangler.toml; then
  ID=$($W kv namespace create recherche-status | grep -oE '[0-9a-f]{32}' | head -1)
  sed -i.bak "s/KV_ID/$ID/" wrangler.toml && rm -f wrangler.toml.bak
fi
$W deploy | tee /tmp/deploy.log
URL=$(grep -oE 'https://[^ ]+workers\.dev' /tmp/deploy.log | head -1)
echo ""
echo ">>> Tape le code équipe (à partager sur WhatsApp) :"
$W secret put CODE
printf '// URL du worker Cloudflare\nwindow.RECHERCHE_API = "%s";\n' "$URL" > config.js
git add config.js wrangler.toml && git commit -qm "Branche la carte sur le worker" && git push -q
echo ""
echo "OK — worker : $URL"
