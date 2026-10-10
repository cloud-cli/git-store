FROM ghcr.io/cloud-cli/image-node:latest
ENV DATA_PATH=/home/app/data
ENV PORT=3000
ENV OIDC_BROWSER_SCOPES="repo:read repo:write"

USER 0
COPY . .
RUN mkdir -p $DATA_PATH && chown -R 1000:1000 $DATA_PATH && pnpm install && pnpm run build

EXPOSE 3000
USER 1000
CMD ["node", "index.js"]
