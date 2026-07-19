FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci

COPY tsconfig.json ./

COPY scripts/ensure-bins.mjs ./scripts/ensure-bins.mjs

COPY src ./src

RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

RUN mkdir -p /app/.contextengine-http && chown -R node:node /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./

COPY --from=build --chown=node:node /app/node_modules ./node_modules

COPY --from=build --chown=node:node /app/dist ./dist

USER node

EXPOSE 8787

CMD ["node", "dist/http-server.js"]
