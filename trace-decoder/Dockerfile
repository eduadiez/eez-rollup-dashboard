FROM node:22-alpine
WORKDIR /app/trace-decoder
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src/ ./src/
COPY flow/model.mjs ./flow/model.mjs
COPY service/ ./service/
ENV NODE_ENV=production EEZ_TRACE_HOST=0.0.0.0 EEZ_TRACE_PORT=8080
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node --input-type=module -e "const r = await fetch('http://127.0.0.1:' + process.env.EEZ_TRACE_PORT + '/api/health'); process.exit(r.ok ? 0 : 1)"
CMD ["node", "service/server.mjs"]
