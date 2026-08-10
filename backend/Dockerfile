# =============================================================================
#  iNCompany Backend — Çok Aşamalı Derleme
#
#  ⚠ DERLEME BAĞLAMI DEPO KÖKÜDÜR, `backend/` DEĞİL:
#      docker build -f backend/Dockerfile .
#
#    Gerekçe: `@incompany/contracts` bir npm workspace paketidir ve
#    `packages/` altında yaşar. Bağlam `backend/` olsaydı bu dizin
#    kopyalanamaz, `npm ci` workspace bağını kuramaz ve derleme
#    "Cannot find module '@incompany/contracts'" ile başarısız olurdu.
#
#  Aşamalar:  deps → development | builder → production
# =============================================================================

# -----------------------------------------------------------------------------
#  Temel — üretimde imaj DIGEST ile sabitlenmelidir (`node:20.17-alpine@sha256:...`).
#  Etiketler yeniden yazılabilir; digest değişmez.
# -----------------------------------------------------------------------------
FROM node:20.17-alpine AS base
WORKDIR /app
# dumb-init: PID 1 olarak sinyalleri doğru iletir. Node doğrudan PID 1
# olduğunda SIGTERM'i varsayılan olarak yok sayar ve düzgün kapanma çalışmaz.
RUN apk add --no-cache dumb-init

# -----------------------------------------------------------------------------
#  Bağımlılıklar — yalnızca manifest dosyaları kopyalanır.
#  Kaynak kod değiştiğinde bu katman önbellekten gelir; `npm ci` yeniden
#  çalışmaz. Manifestleri kaynakla birlikte kopyalamak bu kazancı yok eder.
# -----------------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY backend/package.json ./backend/

# `npm ci` lock dosyasına BİREBİR uyar. `npm install` lock'u güncelleyebilir
# ve derleme, hiç denetlenmemiş bir bağımlılık sürümüyle yapılabilir.
#
# `--ignore-scripts`: postinstall betikleri, bir bağımlılığın derleme
# ortamınızda keyfi kod çalıştırmasına açık kapıdır — tedarik zinciri
# saldırılarının en yaygın vektörü.
RUN npm ci --ignore-scripts

# -----------------------------------------------------------------------------
#  Geliştirme
# -----------------------------------------------------------------------------
FROM base AS development
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY package.json ./
COPY packages ./packages
COPY backend ./backend
# Paylaşılan sözleşme, backend'den önce derlenmelidir.
RUN npm run build --workspace @incompany/contracts
WORKDIR /app/backend
EXPOSE 3000 9229
CMD ["dumb-init", "npm", "run", "start:dev"]

# -----------------------------------------------------------------------------
#  Derleme
# -----------------------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY packages ./packages
COPY backend ./backend

# SIRA ÖNEMLİ: contracts önce derlenir, backend ona `node_modules`
# sembolik bağı üzerinden `dist/events.js` olarak erişir.
RUN npm run build --workspace @incompany/contracts
RUN npm run build --workspace @incompany/backend

# Geliştirme bağımlılıklarını at — üretim imajında derleyici, test koşucusu
# ve linter'ın bulunmasının gerekçesi yoktur ve her biri ayrı bir CVE yüzeyidir.
RUN npm prune --omit=dev --workspaces --include-workspace-root

# -----------------------------------------------------------------------------
#  Üretim — distroless
#
#  Distroless imajda KABUK, PAKET YÖNETİCİSİ ve COREUTILS YOKTUR.
#  Bir RCE elde eden saldırgan `curl | sh`, `wget`, `apk add` yapamaz;
#  `ls` bile çalıştıramaz. Saldırının ilerlemesini durduran en ucuz önlem.
# -----------------------------------------------------------------------------
FROM gcr.io/distroless/nodejs20-debian12:nonroot AS production

ENV NODE_ENV=production
# Konteyner bellek limitinin ALTINDA bir heap sınırı: Node'un varsayılan
# heap'i konteyner limitini bilmez ve OOM-kill ile aniden ölür.
ENV NODE_OPTIONS="--max-old-space-size=768 --enable-source-maps"

WORKDIR /app

# Kök `node_modules` (hoist edilmiş bağımlılıklar + contracts sembolik bağı)
COPY --from=builder --chown=nonroot:nonroot /app/node_modules ./node_modules
# Sembolik bağın hedefi — `packages/contracts/dist` olmadan bağ kırık kalır.
COPY --from=builder --chown=nonroot:nonroot /app/packages ./packages
COPY --from=builder --chown=nonroot:nonroot /app/backend/dist ./backend/dist
COPY --from=builder --chown=nonroot:nonroot /app/backend/package.json ./backend/

USER nonroot
WORKDIR /app/backend
EXPOSE 3000

# Sağlık kontrolü Kubernetes probe'larıyla yapılır (`/health`, `/health/ready`);
# imajda HEALTHCHECK tanımlamak K8s ortamında gereksiz bir süreç daha başlatır.

# distroless/nodejs imajında ENTRYPOINT zaten `node`'dur.
CMD ["dist/main.js"]
