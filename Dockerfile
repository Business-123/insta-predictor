# Base image comes from AWS's public mirror of Docker Hub's official images,
# so builds are not affected by Docker Hub rate limits (HTTP 429).
FROM public.ecr.aws/docker/library/node:20-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
