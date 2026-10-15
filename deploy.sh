#!/usr/bin/env bash
set -euo pipefail

# Build, push, and deploy the CS Agent to SAP BTP Cloud Foundry.
# BTP does not build from a Dockerfile on push, so the image is built locally
# for linux/amd64 and pulled from Docker Hub.
#
# Usage (from anywhere):
#   ./scripts/deploy-cf.sh
#
# First run, or after the CF token expires, the script opens an SSO prompt.
# Open that passcode link in Chrome and paste the code back into the terminal.

DOCKER_USER="${DOCKER_USER:-vishnuvryeruva98}"
IMAGE_NAME="${IMAGE_NAME:-cs-agent}"
CF_API="${CF_API:-https://api.cf.us10.hana.ondemand.com}"
CF_ORG="${CF_ORG:-Johnson & Johnson Services, Inc._dev-sfdc-rq24o0we}"
CF_SPACE="${CF_SPACE:-jnj-mt-dev}"
AICORE_INSTANCE="${AICORE_INSTANCE:-jnj-mt-dev-aicore}"
APP_NAME="${APP_NAME:-cs-agent}"
# "cs-agent" is already taken in another space on this landscape.
APP_ROUTE="${APP_ROUTE:-jnj-mt-dev-cs-agent.cfapps.us10.hana.ondemand.com}"
TAG="v$(date +%Y%m%d%H%M)"
IMAGE="${DOCKER_USER}/${IMAGE_NAME}:${TAG}"

cd "$(dirname "$0")/.."

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop, then run this script again."
  exit 1
fi

echo "==> Building ${IMAGE} for linux/amd64"
docker buildx build --platform linux/amd64 \
  -t "${IMAGE}" \
  -t "${DOCKER_USER}/${IMAGE_NAME}:latest" \
  --push .

echo "==> Pointing manifest.yml at ${IMAGE}"
python3 - "${IMAGE}" "${APP_ROUTE}" <<'PY'
import pathlib, sys
image, route = sys.argv[1], sys.argv[2]
path = pathlib.Path("manifest.yml")
lines = path.read_text().splitlines()
out = []
i = 0
saw_image = False
while i < len(lines):
    line = lines[i]
    if line.startswith("      image:"):
        out.append(f"      image: {image}")
        out.append("    default-route: false")
        out.append("    routes:")
        out.append(f"      - route: {route}")
        saw_image = True
        i += 1
        while i < len(lines) and (
            lines[i].strip().startswith("default-route:")
            or lines[i].strip() == "routes:"
            or lines[i].strip().startswith("- route:")
        ):
            i += 1
        continue
    out.append(line)
    i += 1
if not saw_image:
    raise SystemExit("manifest.yml has no docker image line")
path.write_text("\n".join(out) + "\n")
PY

echo "==> Cloud Foundry (${CF_ORG} / ${CF_SPACE})"
if ! cf oauth-token >/dev/null 2>&1; then
  echo "==> Login required. Open the passcode link in Chrome and paste the code."
  cf login -a "${CF_API}" --sso -o "${CF_ORG}" -s "${CF_SPACE}"
fi
cf target -o "${CF_ORG}" -s "${CF_SPACE}"

echo "==> Pushing ${APP_NAME}"
cf push "${APP_NAME}" -f manifest.yml

echo "==> Binding ${AICORE_INSTANCE}"
bind_out="$(cf bind-service "${APP_NAME}" "${AICORE_INSTANCE}" 2>&1)" || true
if printf '%s\n' "${bind_out}" | grep -qi "already bound"; then
  echo "==> ${AICORE_INSTANCE} is already bound"
elif printf '%s\n' "${bind_out}" | grep -q "^OK"; then
  printf '%s\n' "${bind_out}"
  cf restart "${APP_NAME}"
else
  printf '%s\n' "${bind_out}"
  echo "Failed to bind ${AICORE_INSTANCE}."
  exit 1
fi

echo
echo "==> Deployed."
echo "    https://${APP_ROUTE}"
curl -fsS "https://${APP_ROUTE}/api/v1/health"
echo
cf app "${APP_NAME}" | head -8