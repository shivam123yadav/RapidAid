# Stage 1: Build TypeScript backend
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency manifests and TypeScript configuration files
COPY package*.json ./
COPY tsconfig*.json ./

# Install full dependencies (including devDependencies required for build)
RUN npm ci

# Copy backend TypeScript source code
COPY src/ ./src/

# Provide ambient module declaration for optional server-whisper provider so tsc compiles cleanly in isolation
RUN printf 'declare module "@huggingface/transformers";\n' > src/transformers.d.ts

# Compile TypeScript into dist/
RUN npm run build

# Stage 2: Production runtime environment
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=5000 \
    VOICE_AUDIO_STORAGE_DIR=/app/storage/voice

# Copy package manifests and install production-only dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled JavaScript output from builder stage
COPY --from=builder /app/dist ./dist

# Create voice audio storage directory with proper node ownership
RUN mkdir -p /app/storage/voice && chown -R node:node /app

# Run as non-root user node (UID 1000)
USER node

EXPOSE 5000

# Process liveness healthcheck targeting /healthz (does not fail during DB reconnects)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 5000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
