# syntax=docker/dockerfile:1.7

FROM oven/bun:1 AS build
WORKDIR /app

COPY package.json ./
COPY servers/nextjs/package.json servers/nextjs/package-lock.json servers/nextjs/bun.lock ./servers/nextjs/
RUN cd servers/nextjs && bun install

COPY . .
RUN cd servers/nextjs && bunx next build

FROM oven/bun:1 AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    APP_DATA_DIRECTORY=/app_data \
    TEMP_DIRECTORY=/tmp/presenton \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update && apt-get install -y \
    python3 \
    python3-venv \
    python3-pip \
    libreoffice \
    fontconfig \
    chromium \
    curl && \
    rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://ollama.com/install.sh | sh

COPY --from=build /app /app

RUN python3 -m pip install --upgrade pip && \
    pip install --no-cache-dir \
      aiohttp \
      aiomysql \
      aiosqlite \
      asyncpg \
      fastapi[standard] \
      pathvalidate \
      pdfplumber \
      chromadb \
      sqlmodel \
      anthropic \
      google-genai \
      openai \
      fastmcp \
      dirtyjson \
      python-pptx \
      redis \
      nltk && \
    pip install --no-cache-dir docling --extra-index-url https://download.pytorch.org/whl/cpu

RUN mkdir -p /app_data

EXPOSE 3000

CMD ["bun", "run", "start"]
