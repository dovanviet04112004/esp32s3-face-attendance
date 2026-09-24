# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
# The engines download is a postinstall, and npm blocks those unless allowed.
RUN npm ci --ignore-scripts && npm rebuild @prisma/engines prisma

COPY tsconfig.json tsconfig.build.json nest-cli.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
# generate opens no connection, but the config asks for a url either way. This
# stage is discarded, so the placeholder never reaches the shipped image.
ENV DATABASE_URL=postgresql://unused:unused@127.0.0.1:5432/unused
RUN npx prisma generate && npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild @prisma/engines prisma && npm cache clean --force

COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
COPY prisma.config.ts ./

# A fresh named volume takes this directory's owner, and the api writes as node (KEHOACH 7.7).
RUN mkdir -p /releases && chown node:node /releases

USER node
EXPOSE 3000
# The schema reaches the database before the first request does.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
