ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim
FROM ${NODE_IMAGE}

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0

COPY package.json package-lock.json ./
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm config set registry "${NPM_REGISTRY}" \
  && npm ci --omit=dev

COPY src ./src
COPY migrations ./migrations
COPY README.md ./
COPY doc ./doc

EXPOSE 8787

CMD ["node", "src/backend/server.js"]
