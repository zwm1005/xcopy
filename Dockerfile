FROM node:24-bookworm-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.frontend.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY server/assets.js ./server/assets.js
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && mkdir /data && chown node:node /data
COPY server ./server
COPY src/shared ./src/shared
COPY scripts/frontend-artifact.js ./scripts/frontend-artifact.js
COPY --from=frontend /app/dist ./dist
USER node
ENV HOST=0.0.0.0 PORT=8787 DB_PATH=/data/suichuan.sqlite
EXPOSE 8787
CMD ["node", "server/index.js"]
