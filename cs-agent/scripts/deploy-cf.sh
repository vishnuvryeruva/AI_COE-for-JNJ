#!/usr/bin/env bash
set -euo pipefail

# Build, push, and deploy the CS Agent to SAP BTP Cloud Foundry.
# BTP does not build from a Dockerfile on push, so the image must be built
# locally for linux/amd64 and pulled from a registry.

DOCKER_USER="${DOCKER_USER:-vishnuvryeruva98}"
IMAGE_NAME="${IMAGE_NAME:-cs-agent}"
# J&J sandbox: org jnj-cb-sbx-ai / space jnj-cb-sbx-so-poc (same place as sales-intelligence)
CF_API="${CF_API:-https://api.cf.us10.hana.ondemand.com}"
CF_ORG="${CF_ORG:-jnj-cb-sbx-ai}"
CF_SPACE="${CF_SPACE:-jnj-cb-sbx-so-poc}"
AICORE_INSTANCE="${AICORE_INSTANCE:-so-poc-aicore}"
APP_NAME="${APP_NAME:-cs-agent}"
TAG="v$(date +%Y%m%d%H%M)"
IMAGE="${DOCKER_USER}/${IMAGE_NAME}:${TAG}"

cd "$(dirname "$0")/.."

# Refuse an unrelated API before publishing or changing any deployment.
if ! cf target | grep -Fq "${CF_API}"; then
  echo "Sign in to the intended BTP API first: cf login -a ${CF_API} --sso" >&2
  exit 1
fi
cf target -o "${CF_ORG}" -s "${CF_SPACE}"

echo "==> Building ${IMAGE} for linux/amd64"
docker buildx build --platform linux/amd64 -t "${IMAGE}" -t "${DOCKER_USER}/${IMAGE_NAME}:latest" --push .

echo "==> Pointing manifest.yml at ${IMAGE}"
if [[ "$(uname)" == "Darwin" ]]; then
  sed -i '' "s|image: .*|image: ${IMAGE}|" manifest.yml
else
  sed -i "s|image: .*|image: ${IMAGE}|" manifest.yml
fi

echo "==> Pushing ${APP_NAME}"
cf push "${APP_NAME}" -f manifest.yml

# The SDK picks the binding up from VCAP_SERVICES, so no key goes in the manifest.
if cf services | grep -q "${AICORE_INSTANCE}.*${APP_NAME}"; then
  echo "==> ${AICORE_INSTANCE} already bound to ${APP_NAME}"
else
  echo "==> Binding ${AICORE_INSTANCE}"
  cf bind-service "${APP_NAME}" "${AICORE_INSTANCE}"
  cf restart "${APP_NAME}"
fi

echo
echo "==> Deployed."
cf app "${APP_NAME}" | head -6
