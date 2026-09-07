# Hosted overlay: the same server as `ctx serve`, in hosted mode.
#   docker build -t context-graph .
#   docker run -p 7400:7400 -e CTX_OVERLAY_TOKEN=change-me -v ctx-data:/data context-graph
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY packs ./packs
COPY scripts ./scripts
RUN npm run gen:packs && npx tsc -p tsconfig.json
COPY view ./view
RUN cd view && npm ci --no-audit --no-fund && npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production CTX_HOME=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY --from=build /app/view/dist ./view/dist
COPY packs ./packs
COPY adapters ./adapters
VOLUME ["/data"]
EXPOSE 7400
CMD ["node", "dist/cli/main.js", "serve", "--hosted", "--port", "7400", "--bind", "0.0.0.0"]
