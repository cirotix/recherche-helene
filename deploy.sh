#!/bin/sh
# Déploie le worker Cloudflare et branche la carte dessus. Lancer depuis le dossier du dépôt.
set -e
W="npx -y wrangler@4"
$W whoami 2>&1 | grep -q "You are logged in" || $W login
$W deploy | tee /tmp/deploy.log
URL=$(grep -oE 'https://[^ ]+workers\.dev' /tmp/deploy.log | head -1)
echo ""
echo ">>> Tape le code équipe (à partager sur WhatsApp) :"
$W secret put CODE
printf '// URL du worker Cloudflare\nwindow.RECHERCHE_API = "%s";\n' "$URL" > config.js
git add config.js wrangler.toml && git commit -qm "Branche la carte sur le worker" && git push -q
echo ""
echo "OK — worker : $URL"
