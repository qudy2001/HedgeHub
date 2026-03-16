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
COPY defaults ./defaults

RUN npm run build \
  && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8787

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/defaults ./defaults

RUN mkdir -p /app/data /app/dashboards

EXPOSE 8787

CMD ["node", "server/index.js"]
