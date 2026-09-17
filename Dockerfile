# Stage 1: build frontend
FROM node:20-slim AS frontend-build

WORKDIR /build

COPY frontend/package*.json ./
RUN npm install

COPY frontend/ ./
RUN npm run build

# Stage 2: production (backend + static frontend)
FROM node:20-slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /tmp/spark-control-center

WORKDIR /app

COPY backend/package*.json ./
RUN npm install

COPY backend/ ./
COPY --from=frontend-build /build/dist /app/public

EXPOSE 3001

CMD ["node", "index.js"]
