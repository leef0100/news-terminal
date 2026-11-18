# One image for every role. Not yet built or run anywhere: treat as a starting point.
#   docker run -e ROLE=web -e REDIS_URL=redis://redis:6379 -p 3000:3000 halftone
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY config ./config
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
