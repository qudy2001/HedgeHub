FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV MCP_HTTP_HOST=0.0.0.0
ENV MCP_HTTP_PORT=8790

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

USER node

EXPOSE 8790

CMD ["node", "src/http.js"]
