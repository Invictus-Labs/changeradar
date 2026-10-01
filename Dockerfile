# ChangeRadar image: the compiled API, worker, CLI and web UI. No account, license server or telemetry.
#
#   docker build -t changeradar:local .
#   docker run --rm changeradar:local help
#
# The Node floor is pinned to the supported minimum (22.12); the same tag is what the local gate uses to check it.
# Configuration comes from the environment (see .env.example); the image contains no secret and no default password.

FROM node:22.12-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.web.json vite.config.ts ./
COPY src ./src
COPY migrations ./migrations
COPY schemas ./schemas
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22.12-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/schemas ./schemas
COPY fixtures ./fixtures
COPY LICENSE ./LICENSE

# Run as the unprivileged user that ships with the base image. The embedded-database data directory (if used) belongs to it.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]

# The server listens on the address given by CHANGERADAR_HOST. Inside a container that has to be 0.0.0.0 to be reachable
# through a published port; publish it on the host's loopback only (see compose.yaml) unless a TLS proxy fronts it.
EXPOSE 8797
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CHANGERADAR_PORT||8797)+'/api/v1/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "dist/src/cli.js"]
CMD ["serve"]
