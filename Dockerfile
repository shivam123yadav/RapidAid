# Stage 1: Build React/Vite frontend
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install dependencies required for Vite build without executing host-targeted scripts
RUN npm install --ignore-scripts

# Copy frontend source, public assets (including bundled voice models and ort), and scripts
COPY . .

# Build frontend application (prebuild triggers sync-voice-model.mjs which validates offline assets)
RUN npm run build

# Stage 2: Serve static bundle via Nginx
FROM nginx:alpine AS runner

# Replace default Nginx configuration with custom SPA reverse-proxy configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy production static build artifacts into Nginx web root
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80 443

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
