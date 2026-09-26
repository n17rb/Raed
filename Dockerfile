# Rayed API — build context is the repository root:
#   docker build -f services/api/Dockerfile .
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app

# Only the API and the database package are installed (not the mobile apps).
RUN printf '{"name":"rayed-api-image","private":true,"workspaces":["services/api","database"]}\n' > package.json
COPY database/package.json database/package.json
COPY services/api/package.json services/api/package.json
RUN npm install --include=dev --no-audit

COPY database database
COPY services/api services/api

RUN chown -R node:node /app
USER node

EXPOSE 4000
CMD ["npm", "run", "start", "--workspace", "@rayed/api"]
