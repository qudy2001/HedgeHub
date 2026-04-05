FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html ./
COPY vite.config.js ./
COPY src ./src
COPY server ./server
COPY shared ./shared
COPY defaults ./defaults

RUN npm run build \
  && npm prune --omit=dev

FROM eclipse-temurin:8-jre-jammy AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8787
ENV HEDGEHUB_START_IBKR_GATEWAY=true
ENV IBKR_GATEWAY_DIR=/opt/ibkr/clientportal.gw
ENV IBKR_GATEWAY_CONF_PATH=root/conf.yaml
ENV IBKR_GATEWAY_PORT=5001
ENV IBKR_CP_BASE_URL=https://127.0.0.1:5001/v1/api

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl sed \
  && rm -rf /var/lib/apt/lists/*

COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/defaults ./defaults

COPY deploy/ibkr-gateway/docker-entrypoint.sh /usr/local/bin/ibkr-gateway-entrypoint
COPY deploy/hedgehub-ibkr/docker-entrypoint.sh /usr/local/bin/hedgehub-ibkr-entrypoint

RUN chmod +x /usr/local/bin/ibkr-gateway-entrypoint /usr/local/bin/hedgehub-ibkr-entrypoint \
  && mkdir -p /app/data /app/dashboards /opt/ibkr/clientportal.gw

EXPOSE 8787 5001

CMD ["hedgehub-ibkr-entrypoint"]
