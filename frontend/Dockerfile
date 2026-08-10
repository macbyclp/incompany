# =============================================================================
#  iNCompany Frontend
#
#  ⚠ DERLEME BAĞLAMI DEPO KÖKÜDÜR:
#      docker build -f frontend/Dockerfile .
#    (Paylaşılan `@incompany/contracts` workspace paketi için gerekli.)
#
#  Üretimde statik dosyalar Nginx ile servis edilir — Node ile DEĞİL.
#  Node bir statik dosya sunucusu olarak hem daha yavaş hem de gereksiz
#  bir çalışma zamanı saldırı yüzeyi taşır.
# =============================================================================

FROM node:20.17-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY frontend/package.json ./frontend/
RUN npm ci --ignore-scripts

# -----------------------------------------------------------------------------
#  Geliştirme
# -----------------------------------------------------------------------------
FROM node:20.17-alpine AS development
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages ./packages
COPY frontend ./frontend
WORKDIR /app/frontend
EXPOSE 5173
CMD ["npm", "run", "dev"]

# -----------------------------------------------------------------------------
#  Derleme
# -----------------------------------------------------------------------------
FROM node:20.17-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY packages ./packages
COPY frontend ./frontend

# VITE_ önekli değerler tarayıcı paketine GÖMÜLÜR ve herkese açıktır.
# Buraya asla sır geçirilmez — yalnızca genel uç nokta adresleri.
ARG VITE_API_URL
ARG VITE_WS_URL
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL

# Not: frontend, contracts'ı Vite alias'ı ile KAYNAKTAN çözer
# (bkz. vite.config.ts). Bu yüzden ayrı bir contracts derlemesi gerekmez —
# paketleyici TypeScript kaynağını doğrudan dönüştürür.
RUN npm run build --workspace @incompany/frontend

# -----------------------------------------------------------------------------
#  Üretim — Nginx, root olmayan
# -----------------------------------------------------------------------------
FROM nginxinc/nginx-unprivileged:1.27-alpine AS production

# `nginx-unprivileged` imajı root olmayan kullanıcıyla çalışır ve
# 8080 portunu dinler (1024 altı portlar root ayrıcalığı gerektirir).
USER nginx

COPY --chown=nginx:nginx frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder --chown=nginx:nginx /app/frontend/dist /usr/share/nginx/html

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
