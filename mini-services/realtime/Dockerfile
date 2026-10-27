FROM oven/bun:1.3.4

WORKDIR /app

COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile

COPY tsconfig.json ./tsconfig.json
COPY src ./src
COPY mini-services/realtime ./mini-services/realtime

ENV NODE_ENV=production
EXPOSE 3003

CMD ["bun", "mini-services/realtime/index.ts"]
