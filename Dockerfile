FROM node:22-slim AS builder

WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium && apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist
RUN mkdir -p /app/data/uploads

EXPOSE 3000
CMD ["node", "dist/server/index.js"]
