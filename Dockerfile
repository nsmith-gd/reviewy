# The Debrief hub (Discord bot + worker server). Workers don't use this image; they run on reviewers' machines.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bin ./bin
COPY src ./src
ENV DEBRIEF_HOME=/data DEBRIEF_HOST=0.0.0.0 DEBRIEF_PORT=8787 NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "bin/debrief.mjs", "hub"]
