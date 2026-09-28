#!/usr/bin/env sh
# Download the Higgsfield-generated sprites listed in assets/manifest.json into assets/<id>.png
set -e
cd "$(dirname "$0")/../assets"
node -e '
const m = require("./manifest.json");
for (const [id, a] of Object.entries(m)) if (a.url) console.log(id + " " + a.url);
' | while read -r id url; do
  echo "-> $id"
  curl -sSfL "$url" -o "$id.png"
done
