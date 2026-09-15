FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir /app/data && chown node:node /app/data
COPY src ./src
USER node
ENV NODE_ENV=production STATE_DIR=/app/data
CMD ["node", "src/cli.js", "run"]
