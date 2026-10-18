FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && mkdir /data && chown node:node /data
COPY server ./server
COPY public ./public
USER node
ENV HOST=0.0.0.0 PORT=8787 DB_PATH=/data/suichuan.sqlite
EXPOSE 8787
CMD ["node", "server/index.js"]
