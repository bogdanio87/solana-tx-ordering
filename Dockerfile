# One image for the whole pipeline: TypeScript experiment (Node 22) + Python analysis.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p . && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /venv && /venv/bin/pip install --no-cache-dir pandas==2.2.3 matplotlib==3.9.2 scipy==1.14.1 tabulate==0.9.0
ENV PATH=/venv/bin:$PATH
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY test ./test
COPY analysis/analyze.py ./analysis/analyze.py
COPY scripts ./scripts
# Keys are NEVER baked into the image: mount ./keys at /keys (or pass PAYER_SECRET_KEY).
VOLUME ["/data", "/keys"]
ENV DATA_DIR=/data KEYPAIR_PATH=/keys/payer.json SUBWALLETS_PATH=/keys/subwallets.json
CMD ["sh", "scripts/pipeline.sh"]
